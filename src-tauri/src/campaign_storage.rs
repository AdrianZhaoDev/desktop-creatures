//! Dedicated V4 session storage. Never opens the legacy world's game-save.json.
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{Manager, WebviewWindow};

#[path = "campaign_storage_validation.rs"]
mod validation;
use validation::{validate_campaign, validate_campaign_previous};

#[path = "campaign_cloud.rs"]
pub(crate) mod cloud;

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_COLLECTION: usize = 50_000;
const MAX_SAFE_NUMBER: f64 = 9_007_199_254_740_991.0;
const MAIN: &str = "campaign-session.json";
const BACKUP: &str = "campaign-session.bak";
const LEGACY: &str = "campaign-legacy.bak";
const CYCLE_V1: &str = "campaign-cycle-v1.bak";
static IO_LOCK: Mutex<()> = Mutex::new(());
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub async fn read_campaign_session(
    window: WebviewWindow,
    profile: String,
) -> Result<Option<String>, String> {
    authorize_request(window.label(), &profile)?;
    let root = crate::storage::app_data_root(window.app_handle())?;
    blocking_storage(move || read_session(&root, &profile)).await
}

#[tauri::command]
pub async fn write_campaign_session_atomic(
    window: WebviewWindow,
    profile: String,
    json: String,
) -> Result<cloud::CheckpointResult, String> {
    authorize_request(window.label(), &profile)?;
    let root = crate::storage::app_data_root(window.app_handle())?;
    blocking_storage(move || cloud::write_and_project(&root, &profile, &json)).await
}

#[tauri::command]
pub async fn preserve_campaign_legacy(
    window: WebviewWindow,
    profile: String,
    raw: String,
) -> Result<(), String> {
    authorize_request(window.label(), &profile)?;
    let root = crate::storage::app_data_root(window.app_handle())?;
    blocking_storage(move || preserve_legacy(&root, &profile, &raw)).await
}

#[tauri::command]
pub async fn preserve_campaign_cycle_v1(
    window: WebviewWindow,
    profile: String,
    raw: String,
) -> Result<(), String> {
    authorize_request(window.label(), &profile)?;
    let root = crate::storage::app_data_root(window.app_handle())?;
    blocking_storage(move || preserve_cycle_v1(&root, &profile, &raw)).await
}

fn authorize_window(label: &str) -> Result<(), String> {
    if label == crate::window_manager::OVERLAY_LABEL {
        Ok(())
    } else {
        Err("仅主战役覆盖层可访问战役存档".into())
    }
}

fn authorize_request(label: &str, profile: &str) -> Result<(), String> {
    authorize_window(label)?;
    profile_component(profile)?;
    // Path syntax is not account identity. Until native Steam API integration can
    // resolve and verify the current account, no renderer-provided Steam profile
    // may reach storage (including reads and legacy import).
    if profile != "local" {
        return Err("Steam 身份服务尚未接入，仅可访问本地战役存档".into());
    }
    Ok(())
}

async fn blocking_storage<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("战役存档后台任务失败：{error}"))?
}

fn invalid(reason: &str) -> String {
    format!("战役存档无效：{reason}")
}

fn profile_component(profile: &str) -> Result<String, String> {
    // Persisted-path compatibility only; IPC authorization is a separate gate.
    if profile == "local" {
        return Ok("local".into());
    }
    if let Some(id) = profile.strip_prefix("steam:") {
        if (1..=20).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_digit()) {
            return Ok(format!("steam-{id}"));
        }
    }
    Err(invalid("profile"))
}

// Reject junctions/symlinks as well as wrong node types in the dedicated subtree.
// The application data root is provided by Tauri, never by the renderer.
fn check_node(path: &Path, directory: bool) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_attributes() & 0x400 != 0 => Err(invalid("存储路径含重解析点")),
        Ok(meta) if (directory && meta.is_dir()) || (!directory && meta.is_file()) => Ok(true),
        Ok(_) => Err(invalid("存储路径类型")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn check_directory_chain(path: &Path) -> Result<(), String> {
    // Check from the volume toward the leaf before following any child path.
    // This narrows, but cannot eliminate, races with a same-user hostile process.
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        check_node(ancestor, true)?;
    }
    Ok(())
}

fn profile_dir(root: &Path, profile: &str, create: bool) -> Result<PathBuf, String> {
    let component = profile_component(profile)?;
    check_directory_chain(root)?;
    if create && !check_node(root, true)? {
        fs::create_dir_all(root).map_err(|error| error.to_string())?;
        check_directory_chain(root)?;
    }
    let namespace = root.join("campaign-v4");
    let dir = namespace.join(component);
    for path in [&namespace, &dir] {
        if !check_node(path, true)? && create {
            match fs::create_dir(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.to_string()),
            }
            check_node(path, true)?;
        }
    }
    Ok(dir)
}

// Windows share_mode(0) excludes another process for the entire transaction.
// Leave the empty lock file in place; deleting a lock file introduces races.
fn process_lock(dir: &Path) -> Result<File, String> {
    check_directory_chain(dir)?;
    let path = dir.join("campaign.lock");
    check_node(&path, false)?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(path)
        .map_err(|error| format!("战役存档锁失败：{error}"))
}

fn read_raw(path: &Path) -> Result<Option<String>, String> {
    check_directory_chain(path.parent().ok_or_else(|| invalid("存储路径"))?)?;
    if !check_node(path, false)? {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|error| error.to_string())?
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err(invalid("文档过大"));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| invalid("UTF-8"))
}

fn read_session(root: &Path, profile: &str) -> Result<Option<String>, String> {
    let _guard = IO_LOCK.lock().map_err(|_| "战役存档锁失败")?;
    let dir = profile_dir(root, profile, false)?;
    // Return the main bytes verbatim, including malformed/future JSON for the TS validator.
    // No backup lookup, legacy lookup, directory creation, or implicit repair.
    read_raw(&dir.join(MAIN))
}

struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        // Only a file exclusively created by this transaction is ever removed.
        if self
            .0
            .parent()
            .is_some_and(|parent| check_directory_chain(parent).is_ok())
        {
            let _ = fs::remove_file(&self.0);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    TempCreated,
    TempWritten,
    TempFlushed,
    TempSynced,
    BackupPrepared,
    BackupPublished,
    BeforePublish,
}

fn stage_file(
    dir: &Path,
    bytes: &[u8],
    checkpoint: &impl Fn(Stage) -> Result<(), String>,
) -> Result<TempFile, String> {
    check_directory_chain(dir)?;
    for _ in 0..64 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!("campaign-{}-{sequence}.tmp", std::process::id()));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        };
        let temp = TempFile(path);
        // Close before cleanup on failure (Windows may otherwise deny deletion).
        let result = (|| {
            checkpoint(Stage::TempCreated)?;
            file.write_all(bytes).map_err(|error| error.to_string())?;
            checkpoint(Stage::TempWritten)?;
            file.flush().map_err(|error| error.to_string())?;
            checkpoint(Stage::TempFlushed)?;
            file.sync_all().map_err(|error| error.to_string())?;
            checkpoint(Stage::TempSynced)
        })();
        drop(file);
        result?;
        return Ok(temp);
    }
    Err(invalid("无法分配临时文件"))
}

fn publish(source: &Path, target: &Path, replace: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    use windows::core::PCWSTR;
    check_directory_chain(target.parent().ok_or_else(|| invalid("发布路径"))?)?;
    check_directory_chain(source.parent().ok_or_else(|| invalid("临时路径"))?)?;
    if !check_node(source, false)? {
        return Err(invalid("临时文件已消失"));
    }
    check_node(target, false)?;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let flags = if replace {
        MOVEFILE_WRITE_THROUGH | MOVEFILE_REPLACE_EXISTING
    } else {
        MOVEFILE_WRITE_THROUGH
    };
    // Same directory/volume, no COPY_ALLOWED and no delete-before-rename fallback.
    // ReplaceFileW is unsuitable: documented error 1177 can rename away the old main.
    unsafe { MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(target.as_ptr()), flags) }
        .map_err(|error| error.to_string())
}

fn write_session(root: &Path, profile: &str, json: &str) -> Result<(), String> {
    write_session_with(root, profile, json, |_| Ok(()))
}

fn write_session_with(
    root: &Path,
    profile: &str,
    json: &str,
    checkpoint: impl Fn(Stage) -> Result<(), String>,
) -> Result<(), String> {
    validate_session(profile, json)?;
    let _guard = IO_LOCK.lock().map_err(|_| "战役存档锁失败")?;
    let dir = profile_dir(root, profile, true)?;
    let _process_guard = process_lock(&dir)?;
    let main = dir.join(MAIN);
    let previous = read_raw(&main)?;
    if let Some(raw) = &previous {
        // Unknown versions or invalid originals must be explicitly recovered, never overwritten.
        validate_previous(profile, raw)?;
    }
    check_node(&dir.join(BACKUP), false)?;
    let temp = stage_file(&dir, json.as_bytes(), &checkpoint)?;
    if let Some(raw) = previous {
        let backup = stage_file(&dir, raw.as_bytes(), &checkpoint)?;
        checkpoint(Stage::BackupPrepared)?;
        publish(&backup.0, &dir.join(BACKUP), true)?;
        checkpoint(Stage::BackupPublished)?;
    }
    checkpoint(Stage::BeforePublish)?;
    // Last fallible step. A failed attempt may refresh bak to the unchanged main.
    publish(&temp.0, &main, true)
}

fn preserve_legacy(root: &Path, profile: &str, raw: &str) -> Result<(), String> {
    profile_component(profile)?;
    validate_legacy(raw)?;
    let _guard = IO_LOCK.lock().map_err(|_| "战役存档锁失败")?;
    let dir = profile_dir(root, profile, true)?;
    let _process_guard = process_lock(&dir)?;
    let legacy = dir.join(LEGACY);
    if let Some(previous) = read_raw(&legacy)? {
        return if previous == raw {
            Ok(())
        } else {
            Err(invalid("已有不同的旧版原文备份"))
        };
    }
    if check_node(&dir.join(MAIN), false)? {
        return Err(invalid("仅首次 V4 写入前可保留旧版原文"));
    }
    let temp = stage_file(&dir, raw.as_bytes(), &|_| Ok(()))?;
    // No replace flag, even after the explicit existence check.
    publish(&temp.0, &legacy, false)
}

fn preserve_cycle_v1(root: &Path, profile: &str, raw: &str) -> Result<(), String> {
    validate_cycle_v1_source(profile, raw)?;
    let _guard = IO_LOCK.lock().map_err(|_| "战役存档锁失败")?;
    let dir = profile_dir(root, profile, false)?;
    let _process_guard = process_lock(&dir)?;
    let main = read_raw(&dir.join(MAIN))?.ok_or_else(|| invalid("待迁移 V4 主存档不存在"))?;
    if main != raw {
        return Err(invalid("待迁移 V4 原文已变化，请重新读取后重试"));
    }
    let backup = dir.join(CYCLE_V1);
    if let Some(previous) = read_raw(&backup)? {
        return if previous == raw {
            Ok(())
        } else {
            Err(invalid("已有不同的 cycle-v1 原文备份；未改动主存档"))
        };
    }
    let temp = stage_file(&dir, raw.as_bytes(), &|_| Ok(()))?;
    publish(&temp.0, &backup, false)
}

// serde_json::Value normally silently keeps the last duplicate key. Reject duplicates
// while parsing so discarded keys cannot smuggle runtime handles into the raw file.
struct StrictJson(Value);
impl<'de> Deserialize<'de> for StrictJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = StrictJson;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("JSON without duplicate keys or runtime handles")
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(StrictJson(Value::Null))
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(StrictJson(value.into()))
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                if value.unsigned_abs() > MAX_SAFE_NUMBER as u64 {
                    return Err(E::custom("unsafe JSON integer"));
                }
                Ok(StrictJson(value.into()))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                if value > MAX_SAFE_NUMBER as u64 {
                    return Err(E::custom("unsafe JSON integer"));
                }
                Ok(StrictJson(value.into()))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                if !value.is_finite() || value.abs() > MAX_SAFE_NUMBER {
                    return Err(E::custom("non-finite or unsafe JSON number"));
                }
                serde_json::Number::from_f64(value)
                    .map(|number| StrictJson(Value::Number(number)))
                    .ok_or_else(|| E::custom("non-finite number"))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(StrictJson(value.into()))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(StrictJson(value)) = sequence.next_element()? {
                    if values.len() >= MAX_COLLECTION {
                        return Err(de::Error::custom("JSON array scale"));
                    }
                    values.push(value);
                }
                Ok(StrictJson(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut entries: A) -> Result<Self::Value, A::Error> {
                let mut values = Map::new();
                while let Some(key) = entries.next_key::<String>()? {
                    if values.len() >= MAX_COLLECTION {
                        return Err(de::Error::custom("JSON map scale"));
                    }
                    let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                    if normalized.contains("handle") || normalized.contains("hwnd") {
                        return Err(de::Error::custom("runtime handle field"));
                    }
                    if values.contains_key(&key) {
                        return Err(de::Error::custom("duplicate JSON key"));
                    }
                    values.insert(key, entries.next_value::<StrictJson>()?.0);
                }
                Ok(StrictJson(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(JsonVisitor)
    }
}

fn parse(raw: &str) -> Result<Value, String> {
    if raw.len() > MAX_BYTES {
        return Err(invalid("文档过大"));
    }
    let value = serde_json::from_str::<StrictJson>(raw)
        .map_err(|error| format!("战役存档 JSON 无效：{error}"))?
        .0;
    let mut pending = vec![(&value, 0)];
    let mut nodes = 0;
    while let Some((value, depth)) = pending.pop() {
        nodes += 1;
        if nodes > 500_000 || depth > 32 {
            return Err(invalid("文档结构过大"));
        }
        match value {
            Value::Object(map) => pending.extend(map.values().map(|child| (child, depth + 1))),
            Value::Array(array) => pending.extend(array.iter().map(|child| (child, depth + 1))),
            _ => {}
        }
    }
    Ok(value)
}

fn exact(value: &Value, fields: &[&str]) -> Result<(), String> {
    match value.as_object() {
        Some(map)
            if map.len() == fields.len() && fields.iter().all(|key| map.contains_key(*key)) =>
        {
            Ok(())
        }
        _ => Err(invalid("字段缺失或额外字段")),
    }
}

fn id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| !text.is_empty() && text.len() <= 2048)
}

fn safe_integer(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|number| {
            number.is_finite()
                && *number >= 0.0
                && number.fract() == 0.0
                && *number <= MAX_SAFE_NUMBER
        })
        .map(|number| number as u64)
}

fn validate_session(profile: &str, raw: &str) -> Result<(), String> {
    profile_component(profile)?;
    let session = parse(raw)?;
    exact(&session, &["sessionVersion", "campaign", "s07Homes"])?;
    if safe_integer(&session["sessionVersion"]) != Some(1) {
        return Err(invalid("会话版本"));
    }
    validate_campaign(profile, &session["campaign"])?;
    validate_homes(&session["s07Homes"], &session["campaign"]["activeRun"])
}

fn validate_previous(profile: &str, raw: &str) -> Result<(), String> {
    let previous = parse(raw)?;
    if previous.get("sessionVersion").is_some() {
        exact(&previous, &["sessionVersion", "campaign", "s07Homes"])?;
        if safe_integer(&previous["sessionVersion"]) != Some(1) {
            return Err(invalid("会话版本"));
        }
        validate_campaign_previous(profile, &previous["campaign"])?;
        validate_homes(&previous["s07Homes"], &previous["campaign"]["activeRun"])
    } else {
        // TS can open a bare V4 document and wrap it on the next checkpoint.
        // This compatibility applies only to the existing main, never to new writes.
        validate_campaign_previous(profile, &previous)
    }
}

fn validate_cycle_v1_source(profile: &str, raw: &str) -> Result<(), String> {
    validate_previous(profile, raw)?;
    let previous = parse(raw)?;
    let campaign = if previous.get("sessionVersion").is_some() {
        &previous["campaign"]
    } else {
        &previous
    };
    let ecology = campaign["activeRun"]["ecology"]
        .as_object()
        .ok_or_else(|| invalid("cycle-v1 活动运行"))?;
    if ecology.contains_key("cycleVersion") {
        return Err(invalid("仅可备份缺少 cycleVersion 的旧 V4 存档"));
    }
    Ok(())
}

fn validate_homes(progress: &Value, run: &Value) -> Result<(), String> {
    if progress.is_null() {
        return Ok(());
    }
    exact(progress, &["runId", "homes"])?;
    let houses = run["houses"]
        .as_array()
        .ok_or_else(|| invalid("S07 houses"))?;
    let actors = run["actors"]
        .as_array()
        .ok_or_else(|| invalid("S07 actors"))?;
    let homes = progress["homes"]
        .as_array()
        .ok_or_else(|| invalid("S07 homes"))?;
    if !id(&progress["runId"])
        || progress["runId"] != run["runId"]
        || homes.len() != 2
        || houses.len() != 2
    {
        return Err(invalid("S07 runId 或双屋结构"));
    }
    let mut ids = HashSet::new();
    for home in homes {
        exact(home, &["id", "visitSequence", "routine"])?;
        if !id(&home["id"])
            || !ids.insert(home["id"].as_str().unwrap())
            || !houses.iter().any(|house| house["id"] == home["id"])
            || safe_integer(&home["visitSequence"]).is_none()
        {
            return Err(invalid("S07 home"));
        }
        let routine = &home["routine"];
        if routine.is_null() {
            continue;
        }
        exact(routine, &["actorId", "elapsedSeconds", "phase", "visit"])?;
        let actor = actors
            .iter()
            .find(|actor| actor["id"] == routine["actorId"] && actor["houseId"] == home["id"])
            .ok_or_else(|| invalid("S07 actor"))?;
        let activity = match routine["phase"].as_str() {
            Some("entering") => "entering-home",
            Some("resting") => "resting",
            Some("exiting") => "exiting-home",
            _ => return Err(invalid("S07 phase")),
        };
        let retired_visit = run["inventory"]["retired"]["homeVisits"]
            .get(home["id"].as_str().unwrap())
            .and_then(safe_integer);
        if !id(&routine["actorId"])
            || !routine["elapsedSeconds"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0.0)
            || !safe_integer(&routine["visit"]).is_some_and(|n| n > 0)
            || routine["visit"] != home["visitSequence"]
            || retired_visit.is_some_and(|visit| safe_integer(&routine["visit"]).unwrap() <= visit)
            || run["phase"] != "running"
            || actor["pose"]["activity"] != activity
            || actor["atHome"].as_bool() != Some(routine["phase"] != "entering")
        {
            return Err(invalid("S07 routine"));
        }
    }
    Ok(())
}

fn validate_legacy(raw: &str) -> Result<(), String> {
    let legacy = parse(raw)?;
    if !legacy.is_object() || !matches!(legacy["saveVersion"].as_u64(), Some(1..=3)) {
        return Err(invalid("旧版存档版本"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "campaign_storage_tests.rs"]
mod tests;
