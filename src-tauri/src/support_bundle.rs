use std::collections::HashSet;

use serde::{Deserialize, Serialize};

const SCHEMA: &str = "desktop-creatures.support.v1";

#[derive(Debug, Clone, Copy, Eq, Hash, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum FaultCode {
    DesktopSurface,
    DevicePlacement,
    Input,
    NativeBridge,
    NavigationBudget,
    RecyclingBin,
    Renderer,
    RuntimeConsistency,
    Watchdog,
    Other,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Health {
    Ok,
    Degraded,
    Unavailable,
    Practice,
}

#[derive(Debug, Clone, Copy, Eq, Hash, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum PauseReason {
    Player,
    Panel,
    Tutorial,
    DesktopDetection,
    Hidden,
    System,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
enum RuntimeKind {
    #[serde(rename = "browser-practice")]
    BrowserPractice,
    #[serde(rename = "tauri")]
    Tauri,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Stage {
    Lobby,
    Mission,
    Settlement,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    None,
    Preparation,
    Running,
    Retreat,
    Siege,
    Victory,
    Defeat,
    Abandoned,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Build {
    app_version: String,
    build_fingerprint: String,
    runtime_kind: RuntimeKind,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AnonymousFault {
    code: FaultCode,
    count: u16,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModuleHealth {
    campaign: Health,
    renderer: Health,
    audio: Health,
    storage: Health,
    input: Health,
    desktop_surface: Health,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Runtime {
    stage: Stage,
    phase: Phase,
    paused: bool,
    pause_reasons: Vec<PauseReason>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalSettings {
    language: Language,
    audio_muted: bool,
    graphics_quality: GraphicsQuality,
    ui_scale: f64,
    motion_effects: EffectLevel,
    flashes: EffectLevel,
    stains: EffectLevel,
    swarm_atmosphere: EffectLevel,
    intensity: Intensity,
    detection_mode: DetectionMode,
    pause_when_panel_open: bool,
    tutorial_prompts: bool,
}

#[derive(Debug, Deserialize, Serialize)]
enum Language {
    #[serde(rename = "en")]
    En,
    #[serde(rename = "zh-CN")]
    ZhCn,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum GraphicsQuality {
    Low,
    Medium,
    High,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum EffectLevel {
    Off,
    Reduced,
    Full,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Intensity {
    Gentle,
    Standard,
    Intense,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum DetectionMode {
    Desktop,
    Practice,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SupportBundle {
    schema: String,
    version: u8,
    exported_on: String,
    build: Build,
    anonymous_faults: Vec<AnonymousFault>,
    module_health: ModuleHealth,
    runtime: Runtime,
    local_settings: LocalSettings,
}

fn safe_ascii(value: &str, maximum: usize, extra: &str) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || index > 0 && extra.as_bytes().contains(&byte)
        })
}

fn valid_day(value: &str) -> bool {
    if value.len() != 10 || value.as_bytes()[4] != b'-' || value.as_bytes()[7] != b'-' {
        return false;
    }
    let Ok(year) = value[0..4].parse::<u32>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u32>() else {
        return false;
    };
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let maximum = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    (1..=maximum).contains(&day)
}

fn parse(value: serde_json::Value) -> Result<serde_json::Value, String> {
    let bundle: SupportBundle =
        serde_json::from_value(value).map_err(|_| "最小支持包结构无效".to_owned())?;
    if bundle.schema != SCHEMA || bundle.version != 1 {
        return Err("最小支持包版本不受支持".into());
    }
    if !valid_day(&bundle.exported_on)
        || !safe_ascii(&bundle.build.app_version, 48, ".+-")
        || !safe_ascii(&bundle.build.build_fingerprint, 128, "._@/+:-")
        || ![1.0, 1.5, 2.0].contains(&bundle.local_settings.ui_scale)
    {
        return Err("最小支持包白名单值无效".into());
    }
    if bundle.anonymous_faults.len() > 10
        || bundle
            .anonymous_faults
            .iter()
            .any(|fault| fault.count == 0 || fault.count > 9999)
        || bundle
            .anonymous_faults
            .iter()
            .map(|fault| fault.code)
            .collect::<HashSet<_>>()
            .len()
            != bundle.anonymous_faults.len()
        || bundle.runtime.pause_reasons.len() > 6
        || bundle
            .runtime
            .pause_reasons
            .iter()
            .copied()
            .collect::<HashSet<_>>()
            .len()
            != bundle.runtime.pause_reasons.len()
        || bundle.runtime.paused != !bundle.runtime.pause_reasons.is_empty()
    {
        return Err("最小支持包计数或暂停状态无效".into());
    }
    let encoded = serde_json::to_value(bundle).map_err(|_| "最小支持包序列化失败".to_owned())?;
    if serde_json::to_vec(&encoded)
        .map_err(|_| "最小支持包序列化失败".to_owned())?
        .len()
        > 32 * 1024
    {
        return Err("最小支持包超过 32 KB".into());
    }
    Ok(encoded)
}

fn authorize_window(label: &str) -> Result<(), String> {
    if label == crate::window_manager::OVERLAY_LABEL {
        Ok(())
    } else {
        Err("仅生产主战役覆盖层可导出最小支持包".into())
    }
}

#[tauri::command]
pub async fn export_support_bundle(
    window: tauri::WebviewWindow,
    support_bundle: serde_json::Value,
) -> Result<bool, String> {
    // Export is user-initiated local I/O, but is still an IPC privilege: passive
    // displays, the trash window, shortcut settings, and unknown WebViews must
    // never be able to open a save dialog or write a bundle.
    authorize_window(window.label())?;
    let safe = parse(support_bundle)?;
    super::save_dialog::export_support_value(safe).await
}

#[cfg(test)]
mod tests {
    use super::{authorize_window, parse};
    use serde_json::{Value, json};

    fn valid() -> Value {
        json!({
            "schema":"desktop-creatures.support.v1","version":1,"exportedOn":"2026-09-13",
            "build":{"appVersion":"1.1.0","buildFingerprint":"desktop-creatures-1.1.0-campaign-v4-support-v1","runtimeKind":"tauri"},
            "anonymousFaults":[{"code":"input","count":2}],
            "moduleHealth":{"campaign":"ok","renderer":"ok","audio":"ok","storage":"ok","input":"degraded","desktopSurface":"ok"},
            "runtime":{"stage":"mission","phase":"running","paused":true,"pauseReasons":["panel"]},
            "localSettings":{"language":"zh-CN","audioMuted":false,"graphicsQuality":"medium","uiScale":1.5,
                "motionEffects":"full","flashes":"reduced","stains":"full","swarmAtmosphere":"reduced",
                "intensity":"standard","detectionMode":"desktop","pauseWhenPanelOpen":true,"tutorialPrompts":true}
        })
    }

    #[test]
    fn accepts_only_the_minimal_schema() {
        assert!(parse(valid()).is_ok());
        for field in [
            "path",
            "steamId",
            "windowTitle",
            "rawLog",
            "runSeed",
            "freeText",
        ] {
            let mut candidate = valid();
            candidate
                .as_object_mut()
                .unwrap()
                .insert(field.into(), json!("private"));
            assert!(parse(candidate).is_err(), "{field}");
        }
    }

    #[test]
    fn rejects_nested_unknowns_and_invalid_values() {
        let mut nested = valid();
        nested["localSettings"]["displayId"] = json!("private-display");
        assert!(parse(nested).is_err());
        let mut precise_time = valid();
        precise_time["exportedOn"] = json!("2026-09-13T12:34:56Z");
        assert!(parse(precise_time).is_err());
        let mut duplicate = valid();
        duplicate["anonymousFaults"] =
            json!([{"code":"input","count":1},{"code":"input","count":2}]);
        assert!(parse(duplicate).is_err());
    }

    #[test]
    fn only_the_production_primary_window_can_export() {
        assert!(authorize_window("overlay-primary").is_ok());
        for label in [
            "trash-bin",
            "shortcut-settings",
            "overlay-screen-1920x1080-p1920-p0-instance-1",
            "unknown-window",
        ] {
            assert!(authorize_window(label).is_err(), "{label}");
        }
    }
}
