use std::sync::Mutex;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_root(app)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

/// Resolve the existing application namespace without creating directories.
pub fn app_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    if std::env::args().any(|arg| arg == "--steam-preview") {
        dir = dir.join("steam-preview");
    } else if std::env::args().any(|arg| arg == "--validation") {
        dir = dir.join("validation-v2");
    }
    Ok(dir)
}

pub fn atomic_write(path: &Path, contents: &[u8], backup: bool) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().map_err(|_| "存档写入锁失败")?;
    let temp = path.with_extension("tmp");
    fs::write(&temp, contents).map_err(|error| error.to_string())?;
    if backup && path.exists() {
        let backup_path = path.with_extension("bak");
        let _ = fs::remove_file(&backup_path);
        fs::copy(path, &backup_path).map_err(|error| error.to_string())?;
    }
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        },
        core::PCWSTR,
    };
    let source: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(target.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn load_game_balance(app: AppHandle, default_json: String) -> Result<String, String> {
    let path = data_dir(&app)?.join("game-balance.json");
    if !path.exists() {
        atomic_write(&path, default_json.as_bytes(), false)?;
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    if let (Ok(mut user), Ok(next)) = (
        serde_json::from_str::<serde_json::Value>(&text),
        serde_json::from_str::<serde_json::Value>(&default_json),
    ) {
        if user.get("revision").and_then(|v| v.as_u64()).unwrap_or(0) < 2 {
            let old: serde_json::Value =
                serde_json::from_str(include_str!("../../assets/config/game-balance.legacy.json"))
                    .map_err(|e| e.to_string())?;
            migrate_defaults(&mut user, &old, &next);
            user["revision"] = serde_json::json!(2);
            if let Some(species) = user["species"].as_array_mut() {
                for s in species {
                    s["liveBirth"] = serde_json::json!(false);
                }
            }
            let updated = serde_json::to_string_pretty(&user).map_err(|e| e.to_string())?;
            atomic_write(&path, updated.as_bytes(), true)?;
            return Ok(updated);
        }
    }
    Ok(text)
}

fn migrate_defaults(
    value: &mut serde_json::Value,
    old: &serde_json::Value,
    next: &serde_json::Value,
) {
    if value == old {
        *value = next.clone();
        return;
    }
    if let (Some(v), Some(n)) = (value.as_object_mut(), next.as_object()) {
        for (key, new) in n {
            if let Some(current) = v.get_mut(key) {
                migrate_defaults(current, &old[key], new);
            } else {
                v.insert(key.clone(), new.clone());
            }
        }
    } else if let (Some(v), Some(n), Some(o)) =
        (value.as_array_mut(), next.as_array(), old.as_array())
    {
        for (i, current) in v.iter_mut().enumerate() {
            if let (Some(before), Some(after)) = (o.get(i), n.get(i)) {
                migrate_defaults(current, before, after);
            }
        }
    }
}

#[tauri::command]
pub fn load_game_state(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let dir = data_dir(&app)?;
    let path = dir.join("game-save.json");
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_game_state(
    app: AppHandle,
    save: serde_json::Value,
    preserve_backup: Option<bool>,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(&save).map_err(|error| error.to_string())?;
    let dir = data_dir(&app)?;
    let path = dir.join("game-save.json");
    if let Ok(previous) = fs::read(&path) {
        if serde_json::from_slice::<serde_json::Value>(&previous)
            .ok()
            .and_then(|v| v["saveVersion"].as_u64())
            == Some(1)
            && !dir.join("game-save.v1.bak").exists()
        {
            atomic_write(&dir.join("game-save.v1.bak"), &previous, false)?;
        }
    }
    if save["saveVersion"].as_u64() == Some(3) {
        if let Ok(previous) = fs::read(&path) {
            if serde_json::from_slice::<serde_json::Value>(&previous)
                .ok()
                .and_then(|v| v["saveVersion"].as_u64())
                == Some(2)
                && !dir.join("game-save.v2.bak").exists()
            {
                atomic_write(&dir.join("game-save.v2.bak"), &previous, false)?;
            }
        }
    }
    atomic_write(&path, &bytes, !preserve_backup.unwrap_or(false))
}

#[tauri::command]
pub fn load_game_backup(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = data_dir(&app)?.join("game-save.bak");
    Ok(fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()))
}

pub fn protected_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let mut roots = vec![
        data_dir(app)?,
        app.path()
            .app_config_dir()
            .map_err(|error| error.to_string())?,
    ];
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    Ok(roots)
}

pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    data_dir(app)
}

#[cfg(test)]
mod tests {
    use super::{atomic_write, migrate_defaults};
    #[test]
    fn migration_updates_defaults_and_preserves_custom_values() {
        let old = serde_json::json!({"time":{"quiet":18,"speed":1},"items":[{"id":"a","size":10}]});
        let next = serde_json::json!({"time":{"quiet":3,"speed":1},"items":[{"id":"a","size":28}],"revision":2});
        let mut custom = old.clone();
        custom["time"]["speed"] = serde_json::json!(4);
        migrate_defaults(&mut custom, &old, &next);
        assert_eq!(custom["time"]["quiet"], 3);
        assert_eq!(custom["time"]["speed"], 4);
        assert_eq!(custom["items"][0]["size"], 28);
        assert_eq!(custom["revision"], 2);
    }
    #[test]
    fn atomic_write_keeps_backup() {
        let dir =
            std::env::temp_dir().join(format!("desktop-creatures-storage-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("save.json");
        atomic_write(&path, b"one", true).unwrap();
        atomic_write(&path, b"two", true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert_eq!(std::fs::read(path.with_extension("bak")).unwrap(), b"one");
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[tauri::command]
pub fn load_companion_balance(app: AppHandle, default_json: String) -> Result<String, String> {
    let path = data_dir(&app)?.join("companion-balance.json");
    if !path.exists() {
        atomic_write(&path, default_json.as_bytes(), false)?;
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}
