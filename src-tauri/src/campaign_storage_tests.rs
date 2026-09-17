use super::*;
use serde_json::json;
use std::sync::{Arc, Barrier};

struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "desktop-creatures-campaign-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        Self(dir)
    }
    fn dir(&self, profile: &str) -> PathBuf {
        profile_dir(&self.0, profile, true).unwrap()
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        // This owned, uniquely created test directory is never a real app-data root.
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn document(profile: &str, marker: u64) -> String {
    let mut value: Value = serde_json::from_str(include_str!(
        "../../docs/steam-v1/evidence/v4-native-storage/ts-empty.json"
    ))
    .unwrap();
    value["campaign"]["profile"] = json!(profile);
    value["campaign"]["meta"]["researchPoints"] = json!(marker);
    value.to_string()
}

fn cycle_v1_document() -> String {
    let mut value: Value = serde_json::from_str(include_str!(
        "../../docs/steam-v1/evidence/v4-native-storage/ts-active.json"
    ))
    .unwrap();
    let ecology = value["campaign"]["activeRun"]["ecology"]
        .as_object_mut()
        .unwrap();
    ecology.remove("cycleVersion");
    ecology.remove("openingSpawned");
    value.to_string()
}

fn with_homes() -> Value {
    let mut value: Value = serde_json::from_str(include_str!(
        "../../docs/steam-v1/evidence/v4-native-storage/ts-active.json"
    ))
    .unwrap();
    value["campaign"]["activeRun"]["actors"][0]["atHome"] = json!(true);
    value["campaign"]["activeRun"]["actors"][0]["pose"]["activity"] = json!("resting");
    value["s07Homes"] = json!({"runId":"native-fixture", "homes":[
        {"id":"home.cleaner", "visitSequence":1, "routine":{"actorId":"actor.cleaner", "elapsedSeconds":0.25, "phase":"resting", "visit":1}},
        {"id":"home.frog", "visitSequence":0, "routine":null}
    ]});
    value
}

fn assert_no_temps(dir: &Path) {
    assert!(fs::read_dir(dir).unwrap().all(|entry| {
        entry
            .unwrap()
            .path()
            .extension()
            .is_none_or(|ext| ext != "tmp")
    }));
}

#[test]
fn profile_allowlist_blocks_traversal_and_windows_aliases_before_io() {
    let sandbox = Sandbox::new();
    for profile in [
        "",
        "LOCAL",
        " local",
        "local.",
        "local/..",
        "../local",
        "..\\local",
        "steam:",
        "steam:1/../2",
        "steam:1\\2",
        "steam:1:ads",
        "steam:+1",
        "steam:-1",
        "steam:１２",
        "steam:1\n",
        "steam:123456789012345678901",
        "C:\\local",
        "\\\\server\\share",
        "local\0",
    ] {
        assert!(read_session(&sandbox.0, profile).is_err(), "{profile:?}");
        assert!(write_session(&sandbox.0, profile, &document(profile, 0)).is_err());
        assert!(preserve_legacy(&sandbox.0, profile, "{\"saveVersion\":1}").is_err());
    }
    assert_eq!(fs::read_dir(&sandbox.0).unwrap().count(), 0);
    for profile in ["local", "steam:0", "steam:01", "steam:12345678901234567890"] {
        assert!(profile_component(profile).is_ok());
    }
}

#[test]
fn rejects_bad_oversized_deep_json_and_duplicate_or_handle_fields() {
    let valid = document("local", 0);
    for raw in ["{", "null", "[]", "{}", "true", "{\"sessionVersion\":NaN}"] {
        assert!(validate_session("local", raw).is_err());
    }
    assert!(validate_session("local", &" ".repeat(MAX_BYTES + 1)).is_err());
    let mut excessive = serde_json::from_str::<Value>(&valid).unwrap();
    excessive["campaign"]["meta"] = json!({"text": "汉".repeat(MAX_BYTES / 3)});
    assert!(validate_session("local", &excessive.to_string()).is_err());
    for field in [
        "handle",
        "hitHandle",
        "hit_handles",
        "native-HANDLE",
        "HWND",
        "byHandle",
    ] {
        let mut bad: Value = serde_json::from_str(&valid).unwrap();
        bad["campaign"]["meta"] = json!({"nested":[{field:42}]});
        assert!(
            validate_session("local", &bad.to_string()).is_err(),
            "{field}"
        );
    }
    assert!(
        validate_session(
            "local",
            &valid.replacen(
                "\"sessionVersion\":1",
                "\"sessionVersion\":2,\"sessionVersion\":1",
                1
            )
        )
        .is_err()
    );
    assert!(
        validate_session(
            "local",
            &valid.replacen(
                "\"researchPoints\":0",
                "\"researchPoints\":1,\"researchPoints\":0",
                1
            )
        )
        .is_err()
    );
    assert!(
        validate_session(
            "local",
            &valid.replace("\"researchPoints\":0", "\"h\\u0061ndle\":4")
        )
        .is_err()
    );
    let mut nested = json!(0);
    for _ in 0..34 {
        nested = json!([nested]);
    }
    let mut bad: Value = serde_json::from_str(&valid).unwrap();
    bad["campaign"]["meta"] = json!({"nested":nested});
    assert!(validate_session("local", &bad.to_string()).is_err());
}

#[test]
fn rejects_missing_extra_version_profile_and_basic_campaign_shape() {
    let valid: Value = serde_json::from_str(&document("local", 0)).unwrap();
    for path in ["", "/campaign"] {
        let keys: Vec<_> = valid
            .pointer(path)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for key in keys {
            let mut bad = valid.clone();
            bad.pointer_mut(path)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(&key);
            assert!(validate_session("local", &bad.to_string()).is_err());
        }
        let mut bad = valid.clone();
        bad.pointer_mut(path).unwrap()["unexpected"] = json!(1);
        assert!(validate_session("local", &bad.to_string()).is_err());
    }
    for (path, replacement) in [
        ("/sessionVersion", json!(2)),
        ("/sessionVersion", json!("1")),
        ("/campaign/saveVersion", json!(5)),
        ("/campaign/profile", json!("steam:1")),
        ("/campaign/meta", Value::Null),
        ("/campaign/activeRun", json!([])),
        ("/campaign/recentSettlement", json!(false)),
        ("/campaign/legacyCompanion", json!(1)),
    ] {
        let mut bad = valid.clone();
        *bad.pointer_mut(path).unwrap() = replacement;
        assert!(
            validate_session("local", &bad.to_string()).is_err(),
            "{path}"
        );
    }
    let mut typo = valid.clone();
    typo["campaign"]
        .as_object_mut()
        .unwrap()
        .remove("saveVersion");
    typo["campaign"]["version"] = json!(4);
    assert!(validate_session("local", &typo.to_string()).is_err());
}

#[test]
fn s07_homes_validate_shape_identity_and_routine_consistency() {
    let valid = with_homes();
    validate_session("local", &valid.to_string()).unwrap();
    for (path, replacement) in [
        ("/s07Homes", json!([])),
        ("/s07Homes/runId", json!("other")),
        ("/s07Homes/homes", json!([])),
        ("/s07Homes/homes/1/id", json!("home.cleaner")),
        ("/s07Homes/homes/1/id", json!("unknown")),
        ("/s07Homes/homes/0/visitSequence", json!(-1)),
        (
            "/s07Homes/homes/0/visitSequence",
            json!(9_007_199_254_740_992_u64),
        ),
        ("/s07Homes/homes/0/routine/visit", json!(2)),
        ("/s07Homes/homes/0/routine/phase", json!("other")),
        ("/s07Homes/homes/0/routine/actorId", json!("unknown")),
        ("/s07Homes/homes/0/routine/elapsedSeconds", json!(-0.1)),
        ("/campaign/activeRun", Value::Null),
        ("/campaign/activeRun/phase", json!("siege")),
        ("/campaign/activeRun/actors/0/atHome", json!(false)),
    ] {
        let mut bad = valid.clone();
        *bad.pointer_mut(path).unwrap() = replacement;
        assert!(
            validate_session("local", &bad.to_string()).is_err(),
            "{path}"
        );
    }
    for path in [
        "/s07Homes",
        "/s07Homes/homes/0",
        "/s07Homes/homes/0/routine",
    ] {
        let mut bad = valid.clone();
        bad.pointer_mut(path).unwrap()["extra"] = json!(1);
        assert!(validate_session("local", &bad.to_string()).is_err());
    }
    let mut null_homes = valid;
    null_homes["s07Homes"] = Value::Null;
    validate_session("local", &null_homes.to_string()).unwrap();

    let mut retired = with_homes();
    retired["campaign"]["activeRun"]["inventory"]["retired"] = json!({
        "ecologyThrough":0, "commandTick":0, "homeVisits":{"home.cleaner":0}
    });
    validate_session("local", &retired.to_string()).unwrap();
    retired["campaign"]["activeRun"]["inventory"]["retired"]["homeVisits"]["home.cleaner"] =
        json!(1);
    assert!(validate_session("local", &retired.to_string()).is_err());
}

#[test]
fn roundtrip_verbatim_backup_rotation_and_old_world_untouched() {
    let sandbox = Sandbox::new();
    fs::write(sandbox.0.join("game-save.json"), b"legacy sentinel").unwrap();
    fs::write(sandbox.0.join("game-save.bak"), b"legacy backup sentinel").unwrap();
    let first = format!("  {}\r\n", document("local", 1));
    write_session(&sandbox.0, "local", &first).unwrap();
    let dir = sandbox.dir("local");
    assert_eq!(
        read_session(&sandbox.0, "local").unwrap(),
        Some(first.clone())
    );
    assert!(!dir.join(BACKUP).exists());
    let second = document("local", 2);
    write_session(&sandbox.0, "local", &second).unwrap();
    assert_eq!(fs::read_to_string(dir.join(BACKUP)).unwrap(), first);
    write_session(&sandbox.0, "local", &document("local", 3)).unwrap();
    assert_eq!(fs::read_to_string(dir.join(BACKUP)).unwrap(), second);
    assert_eq!(
        fs::read(sandbox.0.join("game-save.json")).unwrap(),
        b"legacy sentinel"
    );
    assert_eq!(
        fs::read(sandbox.0.join("game-save.bak")).unwrap(),
        b"legacy backup sentinel"
    );
    assert_no_temps(&dir);
}

#[test]
fn reads_only_main_verbatim_without_fallback_or_creating_directories() {
    let sandbox = Sandbox::new();
    assert_eq!(
        read_session(&sandbox.0.join("absent-root"), "local").unwrap(),
        None
    );
    assert_eq!(fs::read_dir(&sandbox.0).unwrap().count(), 0);
    let dir = sandbox.dir("local");
    fs::write(dir.join(BACKUP), document("local", 1)).unwrap();
    fs::write(dir.join("campaign-stale.tmp"), b"unfinished").unwrap();
    assert_eq!(read_session(&sandbox.0, "local").unwrap(), None);
    for raw in ["{corrupt", "{\"sessionVersion\":999}", ""] {
        fs::write(dir.join(MAIN), raw).unwrap();
        assert_eq!(read_session(&sandbox.0, "local").unwrap(), Some(raw.into()));
        assert!(write_session(&sandbox.0, "local", &document("local", 2)).is_err());
        assert_eq!(fs::read_to_string(dir.join(MAIN)).unwrap(), raw);
    }
    fs::write(dir.join(MAIN), [0xff]).unwrap();
    assert!(read_session(&sandbox.0, "local").is_err());
    fs::write(dir.join(MAIN), vec![b' '; MAX_BYTES + 1]).unwrap();
    assert!(read_session(&sandbox.0, "local").is_err());
}

#[test]
fn validation_failure_never_creates_or_changes_storage() {
    let sandbox = Sandbox::new();
    assert!(write_session(&sandbox.0, "local", "{}").is_err());
    assert_eq!(fs::read_dir(&sandbox.0).unwrap().count(), 0);
    let first = document("local", 1);
    write_session(&sandbox.0, "local", &first).unwrap();
    assert!(write_session(&sandbox.0, "local", &document("steam:2", 2)).is_err());
    assert_eq!(read_session(&sandbox.0, "local").unwrap(), Some(first));
    assert_no_temps(&sandbox.dir("local"));
}

#[test]
fn all_precommit_failures_preserve_main_and_cleanup_owned_temps() {
    for failing in [
        Stage::TempCreated,
        Stage::TempWritten,
        Stage::TempFlushed,
        Stage::TempSynced,
        Stage::BackupPrepared,
        Stage::BackupPublished,
        Stage::BeforePublish,
    ] {
        let sandbox = Sandbox::new();
        let first = document("local", 1);
        write_session(&sandbox.0, "local", &first).unwrap();
        let dir = sandbox.dir("local");
        fs::write(dir.join("unowned.tmp"), b"stale sentinel").unwrap();
        assert!(
            write_session_with(&sandbox.0, "local", &document("local", 2), |stage| {
                if stage == failing {
                    Err("injected I/O failure".into())
                } else {
                    Ok(())
                }
            })
            .is_err(),
            "{failing:?}"
        );
        assert_eq!(read_session(&sandbox.0, "local").unwrap(), Some(first));
        assert_eq!(
            fs::read(dir.join("unowned.tmp")).unwrap(),
            b"stale sentinel"
        );
        assert_eq!(
            fs::read_dir(&dir)
                .unwrap()
                .filter(|entry| entry
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|ext| ext == "tmp"))
                .count(),
            1
        );
    }
}

#[test]
fn injected_backup_write_and_sync_failures_keep_main_and_prior_backup() {
    for failing in [
        Stage::TempCreated,
        Stage::TempWritten,
        Stage::TempFlushed,
        Stage::TempSynced,
    ] {
        let sandbox = Sandbox::new();
        let first = document("local", 1);
        let second = document("local", 2);
        write_session(&sandbox.0, "local", &first).unwrap();
        write_session(&sandbox.0, "local", &second).unwrap();
        let hits = std::cell::Cell::new(0);
        assert!(
            write_session_with(&sandbox.0, "local", &document("local", 3), |stage| {
                if stage == failing {
                    hits.set(hits.get() + 1);
                    if hits.get() == 2 {
                        return Err("injected backup I/O failure".into());
                    }
                }
                Ok(())
            })
            .is_err()
        );
        assert_eq!(read_session(&sandbox.0, "local").unwrap(), Some(second));
        let dir = sandbox.dir("local");
        assert_eq!(fs::read_to_string(dir.join(BACKUP)).unwrap(), first);
        assert_no_temps(&dir);
    }
}

#[test]
fn windows_locked_main_and_backup_fail_without_losing_main() {
    for target in [MAIN, BACKUP] {
        let sandbox = Sandbox::new();
        write_session(&sandbox.0, "local", &document("local", 1)).unwrap();
        let second = document("local", 2);
        write_session(&sandbox.0, "local", &second).unwrap();
        let dir = sandbox.dir("local");
        // FILE_SHARE_READ | FILE_SHARE_WRITE, deliberately no FILE_SHARE_DELETE.
        let held = OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(dir.join(target))
            .unwrap();
        assert!(write_session(&sandbox.0, "local", &document("local", 3)).is_err());
        assert_eq!(read_session(&sandbox.0, "local").unwrap(), Some(second));
        assert_no_temps(&dir);
        drop(held);
        write_session(&sandbox.0, "local", &document("local", 3)).unwrap();
    }
}

#[test]
fn legacy_versions_verbatim_idempotent_and_different_bytes_refused() {
    for version in 1..=3 {
        let sandbox = Sandbox::new();
        let raw = format!(" {{\"saveVersion\":{version},\"name\":\"旧陪伴\"}}\r\n");
        preserve_legacy(&sandbox.0, "local", &raw).unwrap();
        preserve_legacy(&sandbox.0, "local", &raw).unwrap();
        assert!(preserve_legacy(&sandbox.0, "local", raw.trim()).is_err());
        write_session(&sandbox.0, "local", &document("local", 1)).unwrap();
        preserve_legacy(&sandbox.0, "local", &raw).unwrap();
        let dir = sandbox.dir("local");
        assert_eq!(fs::read_to_string(dir.join(LEGACY)).unwrap(), raw);
        assert_no_temps(&dir);
    }
}

#[test]
fn cycle_v1_backup_is_create_once_verbatim_and_precedes_atomic_upgrade() {
    let sandbox = Sandbox::new();
    let dir = sandbox.dir("local");
    let old = format!(" \r\n{}\n", cycle_v1_document());
    fs::write(dir.join(MAIN), &old).unwrap();
    fs::write(dir.join(BACKUP), "existing rolling backup").unwrap();
    preserve_cycle_v1(&sandbox.0, "local", &old).unwrap();
    preserve_cycle_v1(&sandbox.0, "local", &old).unwrap();
    assert_eq!(fs::read_to_string(dir.join(CYCLE_V1)).unwrap(), old);
    assert_eq!(
        fs::read_to_string(dir.join(BACKUP)).unwrap(),
        "existing rolling backup"
    );

    fs::write(dir.join(CYCLE_V1), "different user backup").unwrap();
    assert!(
        preserve_cycle_v1(&sandbox.0, "local", &old)
            .unwrap_err()
            .contains("未改动主存档")
    );
    assert_eq!(fs::read_to_string(dir.join(MAIN)).unwrap(), old);
    fs::write(dir.join(CYCLE_V1), &old).unwrap();

    let current = include_str!("../../docs/steam-v1/evidence/v4-native-storage/ts-active.json");
    write_session(&sandbox.0, "local", current).unwrap();
    assert_eq!(fs::read_to_string(dir.join(CYCLE_V1)).unwrap(), old);
    assert_eq!(fs::read_to_string(dir.join(MAIN)).unwrap(), current);
    assert_eq!(fs::read_to_string(dir.join(BACKUP)).unwrap(), old);
    assert_no_temps(&dir);
}

#[test]
fn cycle_v1_backup_refuses_missing_changed_or_declared_current_main() {
    let sandbox = Sandbox::new();
    let old = cycle_v1_document();
    assert!(preserve_cycle_v1(&sandbox.0, "local", &old).is_err());
    let dir = sandbox.dir("local");
    fs::write(dir.join(MAIN), &old).unwrap();
    assert!(preserve_cycle_v1(&sandbox.0, "local", &format!("{old}\n")).is_err());
    let current = include_str!("../../docs/steam-v1/evidence/v4-native-storage/ts-active.json");
    fs::write(dir.join(MAIN), current).unwrap();
    assert!(preserve_cycle_v1(&sandbox.0, "local", current).is_err());
    assert!(!dir.join(CYCLE_V1).exists());
}

#[test]
fn legacy_rejects_invalid_polluted_future_and_late_first_import() {
    let sandbox = Sandbox::new();
    for raw in [
        "",
        "null",
        "{}",
        "{\"saveVersion\":4}",
        "{\"saveVersion\":1,\"nested\":{\"handle\":1}}",
    ] {
        assert!(preserve_legacy(&sandbox.0, "local", raw).is_err());
    }
    assert!(preserve_legacy(&sandbox.0, "local", &" ".repeat(MAX_BYTES + 1)).is_err());
    assert_eq!(fs::read_dir(&sandbox.0).unwrap().count(), 0);
    write_session(&sandbox.0, "local", &document("local", 1)).unwrap();
    assert!(preserve_legacy(&sandbox.0, "local", "{\"saveVersion\":1}").is_err());
    assert!(!sandbox.dir("local").join(LEGACY).exists());
}

#[test]
fn local_and_steam_profiles_are_independent_including_leading_zero_ids() {
    let sandbox = Sandbox::new();
    let profiles = ["local", "steam:1", "steam:01", "steam:12345678901234567890"];
    for (index, profile) in profiles.iter().enumerate() {
        preserve_legacy(
            &sandbox.0,
            profile,
            &format!("{{\"saveVersion\":1,\"marker\":{index}}}"),
        )
        .unwrap();
        write_session(&sandbox.0, profile, &document(profile, index as u64)).unwrap();
    }
    for (index, profile) in profiles.iter().enumerate() {
        assert_eq!(
            read_session(&sandbox.0, profile).unwrap(),
            Some(document(profile, index as u64))
        );
        assert!(
            fs::read_to_string(sandbox.dir(profile).join(LEGACY))
                .unwrap()
                .contains(&format!("\"marker\":{index}"))
        );
        assert!(!sandbox.dir(profile).join(BACKUP).exists());
    }
}

#[test]
fn concurrent_writers_and_readers_observe_only_complete_documents() {
    let sandbox = Sandbox::new();
    let root = Arc::new(sandbox.0.clone());
    let barrier = Arc::new(Barrier::new(12));
    let threads: Vec<_> = (0..12)
        .map(|index| {
            let root = Arc::clone(&root);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                for revision in 0..4 {
                    write_session(&root, "local", &document("local", index * 4 + revision))
                        .unwrap();
                    let raw = read_session(&root, "local").unwrap().unwrap();
                    validate_session("local", &raw).unwrap();
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let dir = sandbox.dir("local");
    let main = fs::read_to_string(dir.join(MAIN)).unwrap();
    let backup = fs::read_to_string(dir.join(BACKUP)).unwrap();
    validate_session("local", &backup).unwrap();
    assert_ne!(main, backup);
    assert_no_temps(&dir);
}

#[test]
fn concurrent_legacy_same_bytes_succeed_different_bytes_have_one_winner() {
    for same in [true, false] {
        let sandbox = Sandbox::new();
        let barrier = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|index| {
                let root = sandbox.0.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    let marker = if same { 0 } else { index };
                    preserve_legacy(
                        &root,
                        "local",
                        &format!("{{\"saveVersion\":2,\"marker\":{marker}}}"),
                    )
                })
            })
            .collect();
        let successes = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(Result::is_ok)
            .count();
        assert_eq!(successes, if same { 8 } else { 1 });
        assert_no_temps(&sandbox.dir("local"));
    }
}

#[test]
fn windows_process_lock_refuses_contending_writer_and_legacy_but_not_other_profile() {
    let sandbox = Sandbox::new();
    let dir = sandbox.dir("local");
    let held = process_lock(&dir).unwrap();
    assert!(write_session(&sandbox.0, "local", &document("local", 1)).is_err());
    assert!(preserve_legacy(&sandbox.0, "local", "{\"saveVersion\":1}").is_err());
    write_session(&sandbox.0, "steam:1", &document("steam:1", 1)).unwrap();
    drop(held);
    write_session(&sandbox.0, "local", &document("local", 1)).unwrap();
}

#[test]
fn wrong_path_types_cannot_redirect_or_destroy_published_data() {
    let sandbox = Sandbox::new();
    let dir = sandbox.dir("local");
    fs::create_dir(dir.join(MAIN)).unwrap();
    assert!(read_session(&sandbox.0, "local").is_err());
    assert!(write_session(&sandbox.0, "local", &document("local", 1)).is_err());
    assert!(dir.join(MAIN).is_dir());
    let other = Sandbox::new();
    fs::write(other.0.join("campaign-v4"), b"sentinel").unwrap();
    assert!(read_session(&other.0, "local").is_err());
    assert!(write_session(&other.0, "local", &document("local", 1)).is_err());
    assert_eq!(fs::read(other.0.join("campaign-v4")).unwrap(), b"sentinel");
}

#[test]
fn actual_typescript_validated_fixtures_roundtrip_verbatim() {
    for (profile, raw) in [
        (
            "local",
            include_str!("../../docs/steam-v1/evidence/v4-native-storage/ts-empty.json"),
        ),
        (
            "local",
            include_str!("../../docs/steam-v1/evidence/v4-native-storage/ts-active.json"),
        ),
        (
            "local",
            include_str!("../../docs/steam-v1/evidence/v4-native-storage/ts-homes.json"),
        ),
        (
            "steam:12345678901234567890",
            include_str!("../../docs/steam-v1/evidence/v4-native-storage/ts-steam.json"),
        ),
    ] {
        let sandbox = Sandbox::new();
        write_session(&sandbox.0, profile, raw).unwrap();
        assert_eq!(
            read_session(&sandbox.0, profile).unwrap().as_deref(),
            Some(raw)
        );
        write_session(&sandbox.0, profile, raw).unwrap();
        assert_eq!(
            fs::read_to_string(sandbox.dir(profile).join(BACKUP)).unwrap(),
            raw
        );
    }
}

#[test]
fn bare_existing_v4_is_preserved_but_new_writes_require_session() {
    let sandbox = Sandbox::new();
    let session = document("local", 1);
    let bare = serde_json::from_str::<Value>(&session).unwrap()["campaign"].to_string();
    assert!(write_session(&sandbox.0, "local", &bare).is_err());
    let dir = sandbox.dir("local");
    fs::write(dir.join(MAIN), &bare).unwrap();
    assert_eq!(
        read_session(&sandbox.0, "local").unwrap(),
        Some(bare.clone())
    );
    write_session(&sandbox.0, "local", &session).unwrap();
    assert_eq!(fs::read_to_string(dir.join(BACKUP)).unwrap(), bare);
}

// Child runs only this exact test; ordinary full cargo test is a no-op here.
#[test]
fn subprocess_storage_worker() {
    let Some(root) = std::env::var_os("CAMPAIGN_STORAGE_TEST_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    assert!(
        root.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("desktop-creatures-campaign-test-")
    );
    let blocked = std::env::var("CAMPAIGN_STORAGE_TEST_BLOCKED").unwrap() == "1";
    let legacy = preserve_legacy(&root, "local", "{\"saveVersion\":1}");
    let write = write_session(&root, "local", &document("local", 7));
    if blocked {
        assert!(legacy.unwrap_err().contains("锁失败"));
        assert!(write.unwrap_err().contains("锁失败"));
    } else {
        legacy.unwrap();
        write.unwrap();
    }
}

#[test]
fn real_second_process_cannot_write_until_lock_is_released() {
    let sandbox = Sandbox::new();
    let dir = sandbox.dir("local");
    let run_child = |blocked: bool| {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "campaign_storage::tests::subprocess_storage_worker",
                "--nocapture",
            ])
            .env("CAMPAIGN_STORAGE_TEST_ROOT", &sandbox.0)
            .env(
                "CAMPAIGN_STORAGE_TEST_BLOCKED",
                if blocked { "1" } else { "0" },
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    };
    let held = process_lock(&dir).unwrap();
    run_child(true);
    assert!(!dir.join(MAIN).exists());
    assert!(!dir.join(LEGACY).exists());
    drop(held);
    run_child(false);
    assert_eq!(
        read_session(&sandbox.0, "local").unwrap(),
        Some(document("local", 7))
    );
    assert_eq!(
        fs::read_to_string(dir.join(LEGACY)).unwrap(),
        "{\"saveVersion\":1}"
    );
    assert_no_temps(&dir);
}

#[test]
fn windows_directory_junction_cannot_escape_profile_subtree() {
    let sandbox = Sandbox::new();
    let outside = Sandbox::new();
    fs::write(outside.0.join(MAIN), b"outside sentinel").unwrap();
    let namespace = sandbox.0.join("campaign-v4");
    fs::create_dir(&namespace).unwrap();
    let junction = namespace.join("local");
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&outside.0)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(read_session(&sandbox.0, "local").is_err());
    assert!(write_session(&sandbox.0, "local", &document("local", 1)).is_err());
    assert!(preserve_legacy(&sandbox.0, "local", "{\"saveVersion\":1}").is_err());
    assert_eq!(fs::read(outside.0.join(MAIN)).unwrap(), b"outside sentinel");
    // Remove only the junction itself, never recursively through its target.
    fs::remove_dir(junction).unwrap();
}

#[test]
fn only_primary_overlay_is_authorized_without_preview_flag_dependency() {
    assert_eq!(crate::window_manager::OVERLAY_LABEL, "overlay-primary");
    authorize_window(crate::window_manager::OVERLAY_LABEL).unwrap();
    for label in [
        "",
        "trash-bin",
        "shortcut-settings",
        "companion-settings",
        "overlay-screen-0",
        "overlay-secondary",
        "overlay-primary-1",
        "OVERLAY-PRIMARY",
        "overlay-primary ",
    ] {
        assert!(authorize_window(label).is_err(), "{label}");
    }
}

#[test]
fn ipc_rejects_renderer_selected_steam_profiles_until_native_identity_exists() {
    let label = crate::window_manager::OVERLAY_LABEL;
    authorize_request(label, "local").unwrap();
    // These are syntax fixtures, never evidence of real Steam accounts. Even a
    // plausible account-shaped number must fail without a native identity source.
    for profile in [
        "steam:0",
        "steam:1",
        "steam:01",
        "steam:12345678901234567890",
    ] {
        profile_component(profile).unwrap();
        assert!(
            authorize_request(label, profile)
                .unwrap_err()
                .contains("身份服务尚未接入")
        );
    }
    assert!(authorize_request(label, "local/../steam-1").is_err());
    assert!(authorize_request("shortcut-settings", "local").is_err());
}

#[test]
fn frozen_cloud_contract_matches_actual_profile_paths_and_files() {
    let contract: Value =
        serde_json::from_str(include_str!("../../release/steam/cloud-save-contract.json")).unwrap();
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_eq!(contract["applicationIdentifier"], config["identifier"]);
    assert_eq!(contract["files"]["main"], MAIN);
    assert_eq!(contract["files"]["previousMain"], BACKUP);
    assert_eq!(contract["files"]["legacyOriginal"], LEGACY);
    assert_eq!(contract["files"]["cycleV1Original"], CYCLE_V1);
    assert_eq!(contract["document"]["maxUtf8Bytes"], MAX_BYTES);
    assert_eq!(
        contract["identity"]["currentlyAuthorizedProfiles"],
        json!(["local"])
    );
    assert_eq!(contract["identity"]["syntaxIsAuthentication"], false);
    assert_eq!(
        contract["identity"]["rendererMayChooseSteamIdentity"],
        false
    );
    assert_eq!(contract["autoCloud"]["enabled"], false);
    assert_eq!(contract["autoCloud"]["backendConfigured"], false);
    assert_eq!(contract["autoCloud"]["root"], "WinAppDataLocal");
    assert_eq!(contract["contractVersion"], 2);
    assert_eq!(contract["autoCloud"]["pattern"], "campaign-cloud-v1.json");
    assert_eq!(contract["autoCloud"]["recursive"], false);
    let sandbox = Sandbox::new();
    let app_root = sandbox.0.join(config["identifier"].as_str().unwrap());
    let fixture_id = "12345678901234567890";
    let steam_profile = format!("steam:{fixture_id}");
    let expected_steam = contract["relativeDirectory"]["steam"]
        .as_str()
        .unwrap()
        .replace("{64BitSteamID}", fixture_id);
    for namespace in ["normal", "steamPreview", "validation"] {
        let root = app_root.join(contract["runtimeNamespaces"][namespace].as_str().unwrap());
        assert_eq!(
            profile_dir(&root, "local", false).unwrap(),
            root.join(contract["relativeDirectory"]["local"].as_str().unwrap())
        );
        assert_eq!(
            profile_dir(&root, &steam_profile, false).unwrap(),
            root.join(&expected_steam)
        );
    }
    let cloud_directory = contract["autoCloud"]["subdirectory"]
        .as_str()
        .unwrap()
        .replace("{64BitSteamID}", fixture_id);
    assert_eq!(
        sandbox.0.join(cloud_directory),
        profile_dir(&app_root, &steam_profile, false).unwrap()
    );
    // Path derivation and a refused identity must have no filesystem side effects.
    assert_eq!(fs::read_dir(&sandbox.0).unwrap().count(), 0);
    write_session(&app_root, "local", &document("local", 0)).unwrap();
    let dir = profile_dir(&app_root, "local", false).unwrap();
    assert!(
        dir.join(contract["files"]["lock"].as_str().unwrap())
            .is_file()
    );
    let temp = stage_file(&dir, b"contract fixture", &|_| Ok(())).unwrap();
    let name = temp.0.file_name().unwrap().to_str().unwrap();
    assert!(name.starts_with(&format!("campaign-{}-", std::process::id())));
    assert!(name.ends_with(".tmp"));
    drop(temp);
    assert_no_temps(&dir);
}

#[test]
fn migrated_local_main_can_embed_legacy_source_and_is_not_cloud_safe_by_filename() {
    let sandbox = Sandbox::new();
    let mut candidate: Value = serde_json::from_str(&document("local", 0)).unwrap();
    candidate["campaign"]["legacyCompanion"] = json!({
        "saveVersion": 3,
        "source": {"saveVersion": 3, "machineSettings": {"fixtureOnly": true}}
    });
    // Structural native validation intentionally preserves legacy source; never
    // treat successful native validation or a precise filename as a cloud audit.
    write_session(&sandbox.0, "local", &candidate.to_string()).unwrap();
    let saved: Value =
        serde_json::from_str(&read_session(&sandbox.0, "local").unwrap().unwrap()).unwrap();
    assert_eq!(
        saved["campaign"]["legacyCompanion"],
        candidate["campaign"]["legacyCompanion"]
    );
}

#[test]
fn blocking_storage_dispatches_off_caller_thread_and_propagates_result() {
    let caller = std::thread::current().id();
    let sandbox = Sandbox::new();
    let root = sandbox.0.clone();
    let worker = tauri::async_runtime::block_on(blocking_storage(move || {
        write_session(&root, "local", &document("local", 19))?;
        Ok(std::thread::current().id())
    }))
    .unwrap();
    assert_ne!(caller, worker);
    assert_eq!(
        read_session(&sandbox.0, "local").unwrap(),
        Some(document("local", 19))
    );
    assert_eq!(
        tauri::async_runtime::block_on(blocking_storage(|| Err::<(), _>("storage error".into()))),
        Err("storage error".into())
    );
}

#[test]
fn rejects_unsafe_numbers_and_oversized_collections_recursively_before_io() {
    let sandbox = Sandbox::new();
    for number in [
        "9007199254740992",
        "-9007199254740992",
        "18446744073709551615",
        "1e100",
        "1e999",
    ] {
        let raw = format!("{{\"saveVersion\":1,\"nested\":[{{\"value\":{number}}}]}}");
        assert!(
            preserve_legacy(&sandbox.0, "local", &raw).is_err(),
            "{number}"
        );
    }
    let huge_array =
        json!({"saveVersion":1,"nested":{"items":vec![Value::Null; MAX_COLLECTION+1]}}).to_string();
    assert!(preserve_legacy(&sandbox.0, "local", &huge_array).is_err());
    let huge_map: Map<String, Value> = (0..=MAX_COLLECTION)
        .map(|i| (format!("key{i}"), Value::Null))
        .collect();
    let huge_object = json!({"saveVersion":1,"nested":[huge_map]}).to_string();
    assert!(preserve_legacy(&sandbox.0, "local", &huge_object).is_err());
    assert_eq!(fs::read_dir(&sandbox.0).unwrap().count(), 0);
    parse("{\"value\":[-0.25,0.35,1.0,9007199254740991,-9007199254740991]}").unwrap();
}

#[test]
fn app_root_junction_is_rejected_before_read_write_or_legacy() {
    let sandbox = Sandbox::new();
    let outside = Sandbox::new();
    let root = sandbox.0.join("app-data");
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&root)
        .arg(&outside.0)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(read_session(&root, "local").is_err());
    assert!(write_session(&root, "local", &document("local", 0)).is_err());
    assert!(preserve_legacy(&root, "local", "{\"saveVersion\":1}").is_err());
    assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 0);
    fs::remove_dir(root).unwrap();
}

#[test]
fn publication_rechecks_reparse_points_after_temporary_write() {
    let sandbox = Sandbox::new();
    let outside = Sandbox::new();
    let dir = sandbox.dir("local");
    let moved = dir.with_file_name("local-moved-for-test");
    let first = document("local", 1);
    write_session(&sandbox.0, "local", &first).unwrap();
    // Test the publish primitive directly: a namespace change after temp sync must fail.
    let temp = stage_file(&dir, document("local", 2).as_bytes(), &|_| Ok(())).unwrap();
    fs::rename(&dir, &moved).unwrap();
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&dir)
        .arg(&outside.0)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(publish(&temp.0, &dir.join(MAIN), true).is_err());
    drop(temp); // Cleanup must also refuse to traverse the redirected directory.
    assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 0);
    assert_eq!(fs::read_to_string(moved.join(MAIN)).unwrap(), first);
    fs::remove_dir(dir).unwrap();
}

#[test]
fn polluted_core_documents_cannot_replace_published_main_or_backup() {
    let sandbox = Sandbox::new();
    let first = document("local", 1);
    let second = document("local", 2);
    write_session(&sandbox.0, "local", &first).unwrap();
    write_session(&sandbox.0, "local", &second).unwrap();
    for (path, replacement) in [
        ("/campaign/meta", json!({})),
        ("/campaign/meta/researchPoints", json!(0.5)),
        ("/campaign/activeRun", json!({})),
        ("/campaign/recentSettlement", json!({})),
        (
            "/campaign/legacyCompanion",
            json!({"saveVersion":4,"source":{"saveVersion":4}}),
        ),
        (
            "/campaign/legacyCompanion",
            json!({"saveVersion":3,"source":{"saveVersion":2}}),
        ),
    ] {
        let mut candidate: Value = serde_json::from_str(&second).unwrap();
        *candidate.pointer_mut(path).unwrap() = replacement;
        assert!(
            write_session(&sandbox.0, "local", &candidate.to_string()).is_err(),
            "{path}"
        );
        assert_eq!(
            read_session(&sandbox.0, "local").unwrap(),
            Some(second.clone())
        );
        assert_eq!(
            fs::read_to_string(sandbox.dir("local").join(BACKUP)).unwrap(),
            first
        );
    }
    assert_no_temps(&sandbox.dir("local"));
}

#[test]
fn p2_boundary_economic_conservation_still_requires_typescript_validation() {
    // This documents a remaining trust boundary, not a valid gameplay fixture.
    // TS validateGameSaveV4 rejects this ledger (20 seeded parts, no earnings).
    let mut candidate: Value = serde_json::from_str(include_str!(
        "../../docs/steam-v1/evidence/v4-native-storage/ts-active.json"
    ))
    .unwrap();
    candidate["campaign"]["activeRun"]["economy"]["parts"] = json!(999);
    validate_session("local", &candidate.to_string()).unwrap();
}
