use std::path::PathBuf;
use windows::{
    Win32::{
        System::Com::{
            CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
            CoUninitialize,
        },
        UI::Shell::{
            Common::COMDLG_FILTERSPEC, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_OVERWRITEPROMPT,
            FileOpenDialog, FileSaveDialog, IFileDialog, IFileOpenDialog, IFileSaveDialog,
            SIGDN_FILESYSPATH,
        },
    },
    core::{Interface, w},
};

fn choose(export: bool, support_bundle: bool) -> Result<Option<PathBuf>, String> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
        let result = (|| -> windows::core::Result<Option<PathBuf>> {
            let dialog: IFileDialog = if export {
                let d: IFileSaveDialog = CoCreateInstance(&FileSaveDialog, None, CLSCTX_ALL)?;
                d.cast()?
            } else {
                let d: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_ALL)?;
                d.cast()?
            };
            dialog.SetFileTypes(&[COMDLG_FILTERSPEC {
                pszName: if support_bundle {
                    w!("Desktop Creatures 最小支持包")
                } else {
                    w!("Desktop Creatures 存档")
                },
                pszSpec: w!("*.json"),
            }])?;
            dialog.SetDefaultExtension(w!("json"))?;
            dialog.SetOptions(
                FOS_FORCEFILESYSTEM
                    | if export {
                        FOS_OVERWRITEPROMPT
                    } else {
                        FOS_FILEMUSTEXIST
                    },
            )?;
            if export {
                dialog.SetFileName(if support_bundle {
                    w!("desktop-creatures-support.json")
                } else {
                    w!("desktop-creatures-save.json")
                })?;
            }
            match dialog.Show(None) {
                Ok(()) => {}
                Err(e) if e.code().0 as u32 == 0x800704c7 => return Ok(None),
                Err(e) => return Err(e),
            }
            let raw = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
            let name = raw.to_string();
            CoTaskMemFree(Some(raw.as_ptr().cast()));
            Ok(Some(PathBuf::from(name?)))
        })();
        CoUninitialize();
        result.map_err(|e| e.to_string())
    }
}
#[tauri::command]
pub async fn import_game_file() -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(path) = choose(false, false)? else {
            return Ok(None);
        };
        if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 8 * 1024 * 1024 {
            return Err("存档文件超过 8 MB".into());
        }
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("JSON 存档无效：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn export_game_file(save: serde_json::Value) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = choose(true, false)? else {
            return Ok(false);
        };
        let bytes = serde_json::to_vec_pretty(&save).map_err(|e| e.to_string())?;
        super::storage::atomic_write(&path, &bytes, false)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) async fn export_support_value(
    support_bundle: serde_json::Value,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = choose(true, true)? else {
            return Ok(false);
        };
        let bytes = serde_json::to_vec_pretty(&support_bundle).map_err(|e| e.to_string())?;
        super::storage::atomic_write(&path, &bytes, false)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
