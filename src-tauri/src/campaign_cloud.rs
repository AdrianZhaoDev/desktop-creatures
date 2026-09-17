//! Local, versioned safe projection. No Steam SDK, identity resolution or networking.
//! Canonical is authoritative: a failed derived write must not report its commit as failed.
use super::*;
use serde::Serialize;
use serde_json::json;

const CLOUD: &str = "campaign-cloud-v1.json";
const CLOUD_BACKUP: &str = "campaign-cloud-v1.bak";

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointResult {
    canonical_committed: bool,
    cloud_projection: &'static str,
}

#[tauri::command]
pub async fn read_campaign_cloud(
    window: WebviewWindow,
    profile: String,
) -> Result<Option<String>, String> {
    authorize_request(window.label(), &profile)?;
    let root = crate::storage::app_data_root(window.app_handle())?;
    blocking_storage(move || read_cloud(&root, &profile)).await
}

#[tauri::command]
pub async fn refresh_campaign_cloud(
    window: WebviewWindow,
    profile: String,
) -> Result<String, String> {
    authorize_request(window.label(), &profile)?;
    let root = crate::storage::app_data_root(window.app_handle())?;
    blocking_storage(move || refresh_cloud(&root, &profile).map(|()| "current".into())).await
}

#[tauri::command]
pub async fn restore_campaign_cloud(
    window: WebviewWindow,
    profile: String,
    json: String,
) -> Result<String, String> {
    authorize_request(window.label(), &profile)?;
    let root = crate::storage::app_data_root(window.app_handle())?;
    blocking_storage(move || restore_cloud(&root, &profile, &json, |_| Ok(())).map(str::to_owned))
        .await
}

// Stricter than persisted V4 compatibility syntax. Still NOT authentication.
fn cloud_profile(profile: &str) -> Result<(), String> {
    if profile == "local" {
        return Ok(());
    }
    if let Some(id) = profile.strip_prefix("steam:") {
        if id
            .parse::<u64>()
            .ok()
            .is_some_and(|n| n > 0 && n.to_string() == id)
        {
            return Ok(());
        }
    }
    Err(invalid("云投影 profile"))
}

// V4 has exact field allowlists, except its legacy slot (removed below) and opaque
// receipt strings/dynamic ID keys. Admit only bounded ASCII game tokens and JSON
// tuples; embedded objects are exclusively normalized game points. Never retain
// arbitrary JSON objects, filesystem paths, free text or desktop gesture geometry.
fn cloud_text(text: &str, depth: usize, nodes: &mut usize) -> Result<(), String> {
    let lower = text.to_ascii_lowercase();
    if (text.len() >= 2 && text.as_bytes()[0].is_ascii_alphabetic() && text.as_bytes()[1] == b':')
        || ["http:", "https:", "file:", "data:", "smb:", "ssh:"]
            .iter()
            .any(|prefix| lower.starts_with(prefix))
    {
        return Err(invalid("云投影禁止路径前缀"));
    }
    if text.starts_with('[') {
        let tuple = parse(text)?;
        if !tuple.is_array() {
            return Err(invalid("云投影凭据"));
        }
        cloud_values(&tuple, depth + 1, nodes, true)
    } else if text.is_empty()
        || (text.len() <= 512
            && text.as_bytes()[0].is_ascii_alphanumeric()
            && text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            && !text.contains(".."))
    {
        Ok(())
    } else {
        Err(invalid("云投影仅接受游戏标识符"))
    }
}

fn cloud_values(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
    embedded: bool,
) -> Result<(), String> {
    *nodes += 1;
    if depth > 32 || *nodes > 500_000 {
        return Err(invalid("云投影结构上限"));
    }
    match value {
        Value::String(s) => {
            if embedded && s.is_empty() {
                return Err(invalid("云投影空凭据标识符"));
            }
            cloud_text(s, depth, nodes)?;
        }
        Value::Array(items) => {
            for item in items {
                cloud_values(item, depth + 1, nodes, embedded)?;
            }
        }
        Value::Object(map) => {
            if embedded {
                exact(value, &["x", "y"])?;
                if !["x", "y"]
                    .iter()
                    .all(|k| value[*k].as_f64().is_some_and(|n| (0.0..=1.0).contains(&n)))
                {
                    return Err(invalid("云投影游戏坐标"));
                }
            }
            for (key, child) in map {
                cloud_text(key, depth + 1, nodes)?;
                cloud_values(child, depth + 1, nodes, embedded)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn normalize_transient(session: &mut Value) {
    let run = &mut session["campaign"]["activeRun"];
    if run.is_null() {
        return;
    }
    run["pauseReasons"] = Value::Array(
        run["pauseReasons"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| **v == "user")
            .cloned()
            .collect(),
    );
    let swatter = &mut run["swatter"];
    swatter["active"] = json!(false);
    swatter["gestureId"] = json!("");
    swatter["path"] = json!([]);
    swatter["hitIds"] = json!([]);
    swatter["start"] = json!({"x":0,"y":0});
    swatter["end"] = json!({"x":0,"y":0});
}

fn project_session(profile: &str, raw: &str) -> Result<Value, String> {
    cloud_profile(profile)?;
    validate_previous(profile, raw)?;
    let source = parse(raw)?;
    let mut session = if source.get("sessionVersion").is_some() {
        source
    } else {
        json!({"sessionVersion":1,"campaign":source,"s07Homes":null})
    };
    // The only open-ended V4 subtree NEVER crosses this boundary.
    session["campaign"]["legacyCompanion"] = Value::Null;
    normalize_transient(&mut session);
    let projection = json!({"cloudVersion":1,"session":session});
    validate_projection(profile, &projection.to_string())?;
    Ok(projection)
}

fn validate_projection(profile: &str, raw: &str) -> Result<Value, String> {
    cloud_profile(profile)?;
    let projection = parse(raw)?;
    exact(&projection, &["cloudVersion", "session"])?;
    if safe_integer(&projection["cloudVersion"]) != Some(1) {
        return Err(invalid("不支持的云投影版本；保留原文"));
    }
    let session = &projection["session"];
    validate_session(profile, &session.to_string())?;
    if !session["campaign"]["legacyCompanion"].is_null() {
        return Err(invalid("云投影禁止旧陪伴原文"));
    }
    let mut normalized = session.clone();
    normalize_transient(&mut normalized);
    if &normalized != session {
        return Err(invalid("云投影含临时桌面手势或暂停状态"));
    }
    cloud_values(&projection, 0, &mut 0, false)?;
    Ok(projection)
}

pub(super) fn write_and_project(
    root: &Path,
    profile: &str,
    raw: &str,
) -> Result<CheckpointResult, String> {
    write_session(root, profile, raw)?;
    // Refresh re-reads current canonical under BOTH locks. A competing checkpoint
    // between transactions cannot publish a stale snapshot captured by this call.
    let current = refresh_cloud(root, profile).is_ok();
    Ok(CheckpointResult {
        canonical_committed: true,
        cloud_projection: if current { "current" } else { "pending" },
    })
}

fn read_cloud(root: &Path, profile: &str) -> Result<Option<String>, String> {
    cloud_profile(profile)?;
    let _guard = IO_LOCK.lock().map_err(|_| invalid("锁"))?;
    let dir = profile_dir(root, profile, false)?;
    if !check_node(&dir, true)? {
        return Ok(None);
    }
    let _process_guard = process_lock(&dir)?;
    let raw = read_raw(&dir.join(CLOUD))?;
    if let Some(raw) = &raw {
        validate_projection(profile, raw)?;
    }
    Ok(raw)
}

fn refresh_cloud(root: &Path, profile: &str) -> Result<(), String> {
    cloud_profile(profile)?;
    let _guard = IO_LOCK.lock().map_err(|_| invalid("锁"))?;
    let dir = profile_dir(root, profile, false)?;
    if !check_node(&dir, true)? {
        return Err(invalid("缺少本地战役"));
    }
    let _process_guard = process_lock(&dir)?;
    refresh_locked(&dir, profile, &|_| Ok(()))
}

fn refresh_locked(
    dir: &Path,
    profile: &str,
    checkpoint: &impl Fn(Stage) -> Result<(), String>,
) -> Result<(), String> {
    let raw = read_raw(&dir.join(MAIN))?.ok_or_else(|| invalid("缺少本地战役"))?;
    let next = project_session(profile, &raw)?;
    if let Some(backup) = read_raw(&dir.join(CLOUD_BACKUP))? {
        validate_projection(profile, &backup)?;
    }
    let previous = read_raw(&dir.join(CLOUD))?;
    if let Some(old) = &previous {
        // Never overwrite malformed/future cloud downloads; no implicit backup recovery.
        if validate_projection(profile, old)? == next {
            return Ok(());
        }
    }
    check_node(&dir.join(CLOUD_BACKUP), false)?;
    let temp = stage_file(dir, next.to_string().as_bytes(), checkpoint)?;
    if let Some(old) = previous {
        let backup = stage_file(dir, old.as_bytes(), checkpoint)?;
        checkpoint(Stage::BackupPrepared)?;
        publish(&backup.0, &dir.join(CLOUD_BACKUP), true)?;
        checkpoint(Stage::BackupPublished)?;
    }
    checkpoint(Stage::BeforePublish)?;
    publish(&temp.0, &dir.join(CLOUD), true)
}

fn restore_cloud(
    root: &Path,
    profile: &str,
    expected: &str,
    checkpoint: impl Fn(Stage) -> Result<(), String>,
) -> Result<&'static str, String> {
    let projection = validate_projection(profile, expected)?;
    let _guard = IO_LOCK.lock().map_err(|_| invalid("锁"))?;
    let dir = profile_dir(root, profile, false)?;
    if !check_node(&dir, true)? {
        return Err(invalid("缺少云投影"));
    }
    let _process_guard = process_lock(&dir)?;
    // Presence wins even for corrupt/future local documents and legacy-only migration.
    // No timestamp, balance addition, settlement callback or union of ledgers.
    for name in [MAIN, BACKUP, LEGACY, CYCLE_V1] {
        if check_node(&dir.join(name), false)? {
            return Ok("local-present");
        }
    }
    let downloaded = read_raw(&dir.join(CLOUD))?.ok_or_else(|| invalid("缺少云投影"))?;
    if downloaded != expected {
        return Err(invalid("云投影已变化；重新读取验证"));
    }
    validate_projection(profile, &downloaded)?;
    let raw = projection["session"].to_string();
    let temp = stage_file(&dir, raw.as_bytes(), &checkpoint)?;
    checkpoint(Stage::BeforePublish)?;
    publish(&temp.0, &dir.join(MAIN), false)?;
    Ok("restored")
}

#[cfg(test)]
#[path = "campaign_cloud_tests.rs"]
mod tests;
