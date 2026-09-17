use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::mpsc,
};
use tauri::{AppHandle, Emitter};
use windows::{
    Win32::{
        System::Com::{
            CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
        },
        UI::Shell::{
            FILEOPERATION_FLAGS, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOFX_ADDUNDORECORD,
            FOFX_RECYCLEONDELETE, FileOperation, IFileOperation, IShellItem,
            SHCreateItemFromParsingName, SHQUERYRBINFO, SHQueryRecycleBinW,
        },
    },
    core::PCWSTR,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorialRequest {
    memorial_number: u64,
    metadata: serde_json::Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashReceipt {
    receipt_id: String,
    file_name: String,
    byte_length: usize,
    recycled: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Journal {
    receipts: Vec<TrashReceipt>,
}

fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn recycle_paths_sta(paths: Vec<PathBuf>) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|error| error.to_string())
                .and_then(|_| {
                    let operation: IFileOperation =
                        CoCreateInstance(&FileOperation, None, CLSCTX_ALL)
                            .map_err(|error| error.to_string())?;
                    let flags = FILEOPERATION_FLAGS(
                        FOFX_RECYCLEONDELETE.0
                            | FOFX_ADDUNDORECORD.0
                            | FOF_NOCONFIRMATION.0
                            | FOF_NOERRORUI.0
                            | FOF_SILENT.0,
                    );
                    operation
                        .SetOperationFlags(flags)
                        .map_err(|error| error.to_string())?;
                    for path in &paths {
                        let encoded = wide(path);
                        let item: IShellItem =
                            SHCreateItemFromParsingName(PCWSTR(encoded.as_ptr()), None)
                                .map_err(|error| error.to_string())?;
                        operation
                            .DeleteItem(&item, None)
                            .map_err(|error| error.to_string())?;
                    }
                    operation
                        .PerformOperations()
                        .map_err(|error| error.to_string())?;
                    if operation
                        .GetAnyOperationsAborted()
                        .map_err(|error| error.to_string())?
                        .as_bool()
                    {
                        Err("系统回收操作已中止".to_owned())
                    } else {
                        Ok(())
                    }
                })
        };
        unsafe {
            CoUninitialize();
        }
        let _ = sender.send(result);
    });
    receiver.recv().map_err(|error| error.to_string())?
}

fn journal_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(super::storage::app_data_dir(app)?.join("recycle-journal.json"))
}
fn read_journal(app: &AppHandle) -> Journal {
    let Ok(path) = journal_path(app) else {
        return Journal::default();
    };
    [path.clone(), path.with_extension("bak")]
        .into_iter()
        .find_map(|p| {
            fs::read(p)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        })
        .unwrap_or_default()
}

fn write_journal(app: &AppHandle, journal: &Journal) -> Result<(), String> {
    let path = journal_path(app)?;
    super::storage::atomic_write(
        &path,
        &serde_json::to_vec(journal).map_err(|error| error.to_string())?,
        true,
    )
}

#[tauri::command]
pub fn next_memorial_number(app: AppHandle) -> u64 {
    read_journal(&app)
        .receipts
        .iter()
        .filter_map(|r| r.receipt_id.strip_prefix("memorial-")?.parse::<u64>().ok())
        .max()
        .unwrap_or(0)
        .saturating_add(1)
}

fn safe_name(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .take(40)
        .collect()
}

fn memorial_bytes(metadata: &serde_json::Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(metadata).map_err(|error| error.to_string())?;
    if bytes.len() > 1024 {
        return Err("纪念文件元数据超过 1024 字节".to_owned());
    }
    bytes.resize(1024, b' ');
    Ok(bytes)
}

#[tauri::command]
pub fn recycle_game_object(
    app: AppHandle,
    request: MemorialRequest,
) -> Result<TrashReceipt, String> {
    let receipt_id = format!("memorial-{:06}", request.memorial_number);
    let mut journal = read_journal(&app);
    if let Some(receipt) = journal
        .receipts
        .iter()
        .find(|item| item.receipt_id == receipt_id)
    {
        if receipt.recycled {
            return Ok(receipt.clone());
        }
        let staged = super::storage::app_data_dir(&app)?
            .join("memorial-staging")
            .join(&receipt.file_name);
        if !staged.exists() {
            let recovered = TrashReceipt {
                recycled: true,
                ..receipt.clone()
            };
            if let Some(item) = journal
                .receipts
                .iter_mut()
                .find(|item| item.receipt_id == receipt_id)
            {
                *item = recovered.clone();
            }
            write_journal(&app, &journal)?;
            return Ok(recovered);
        }
    }
    let kind = request
        .metadata
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("object");
    let (prefix, name, age_key, age_label) = match kind {
        "roach" => (
            "蟑螂",
            request
                .metadata
                .get("species")
                .and_then(|v| v.as_str())
                .unwrap_or("未知"),
            "livedSeconds",
            "存活",
        ),
        "egg" => (
            "虫卵",
            request
                .metadata
                .get("species")
                .and_then(|v| v.as_str())
                .unwrap_or("未知"),
            "existedSeconds",
            "存活",
        ),
        _ => (
            "垃圾",
            request
                .metadata
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("未知"),
            "existedSeconds",
            "存在",
        ),
    };
    let age = request
        .metadata
        .get(age_key)
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let file_name = format!(
        "{}_{}_{:06}号_{}{:07}秒.txt",
        prefix,
        safe_name(name),
        request.memorial_number,
        age_label,
        age
    );
    let staging = super::storage::app_data_dir(&app)?.join("memorial-staging");
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let path = staging.join(&file_name);
    let bytes = memorial_bytes(&request.metadata)?;
    fs::write(&path, &bytes).map_err(|error| error.to_string())?;
    let mut receipt = TrashReceipt {
        receipt_id,
        file_name,
        byte_length: 1024,
        recycled: false,
    };
    journal
        .receipts
        .retain(|item| item.receipt_id != receipt.receipt_id);
    journal.receipts.push(receipt.clone());
    write_journal(&app, &journal)?;
    if let Err(error) = recycle_paths_sta(vec![path.clone()]) {
        let _ = fs::remove_file(path);
        journal
            .receipts
            .retain(|item| item.receipt_id != receipt.receipt_id);
        let _ = write_journal(&app, &journal);
        return Err(error);
    }
    receipt.recycled = true;
    if let Some(item) = journal
        .receipts
        .iter_mut()
        .find(|item| item.receipt_id == receipt.receipt_id)
    {
        *item = receipt.clone();
    }
    write_journal(&app, &journal)?;
    Ok(receipt)
}

pub fn recycle_external_paths(app: AppHandle, paths: Vec<PathBuf>) {
    std::thread::spawn(move || {
        let outcome = validate_external_paths(&app, &paths)
            .and_then(|_| recycle_paths_sta(paths))
            .map(|_| true);
        let _ = app.emit(
            "trash://external-result",
            outcome.map_err(|error| error.to_string()),
        );
    });
}

fn validate_external_paths(app: &AppHandle, paths: &[PathBuf]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("没有可回收项目".to_owned());
    }
    let roots = super::storage::protected_roots(app)?;
    for path in paths {
        let canonical = path.canonicalize().map_err(|error| error.to_string())?;
        if roots.iter().any(|root| {
            root.canonicalize()
                .ok()
                .is_some_and(|protected| canonical.starts_with(protected))
        }) {
            return Err("拒绝回收应用目录、配置目录、存档目录或暂存目录".to_owned());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn query_recycle_bin_count() -> Result<i64, String> {
    let mut info = SHQUERYRBINFO {
        cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
        ..Default::default()
    };
    unsafe {
        SHQueryRecycleBinW(PCWSTR::null(), &mut info).map_err(|error| error.to_string())?;
    }
    Ok(info.i64NumItems)
}

#[tauri::command]
pub fn open_recycle_bin() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("explorer.exe")
        .arg("shell:RecycleBinFolder")
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{memorial_bytes, safe_name};
    #[test]
    fn memorial_names_remove_windows_separators() {
        assert_eq!(safe_name("a/b:c"), "a_b_c");
    }
    #[test]
    fn memorial_is_utf8_without_bom_and_exactly_one_kibibyte() {
        let bytes =
            memorial_bytes(&serde_json::json!({"kind":"roach","species":"德国小蠊"})).unwrap();
        assert_eq!(bytes.len(), 1024);
        assert!(!bytes.starts_with(&[0xef, 0xbb, 0xbf]));
        assert_eq!(bytes[1023], b' ');
    }
}
