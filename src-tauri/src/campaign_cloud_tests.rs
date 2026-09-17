use super::*;

const EMPTY: &str = include_str!("../../docs/steam-v1/evidence/v4-native-storage/ts-empty.json");
const ACTIVE: &str = include_str!("../../docs/steam-v1/evidence/v4-native-storage/ts-active.json");
const HOMES: &str = include_str!("../../docs/steam-v1/evidence/v4-native-storage/ts-homes.json");

fn javascript_float_exchange(mode: &str, input: &str) -> String {
    use std::process::{Command, Stdio};
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/cloud-float-exchange.mjs");
    let mut child = Command::new("node")
        .arg(script)
        .arg(mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "JS {mode}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn javascript_native_projection_and_disk_restore_preserve_ieee_bits() {
    // JavaScript produces actual JSON.stringify wire text and independently captures
    // IEEE bits with DataView. Expectations are decimal strings, never re-parsed f64s.
    let fixtures = parse(&javascript_float_exchange("generate", ACTIVE)).unwrap();
    let mut results = Vec::new();
    for fixture in fixtures.as_array().unwrap() {
        let name = fixture["name"].as_str().unwrap();
        let original = fixture["raw"].as_str().unwrap();
        let expected_point: u64 = fixture["pointBits"].as_str().unwrap().parse().unwrap();
        let expected_velocity: u64 = fixture["velocityBits"].as_str().unwrap().parse().unwrap();
        let assert_bits = |raw: &str| {
            let value = parse(raw).unwrap();
            let pose = &value["campaign"]["activeRun"]["actors"][0]["pose"];
            assert_eq!(
                pose["x"].as_f64().unwrap().to_bits(),
                expected_point,
                "{name}: x"
            );
            assert_eq!(
                pose["vx"].as_f64().unwrap().to_bits(),
                expected_velocity,
                "{name}: vx"
            );
        };
        assert_bits(original);
        let source = Sandbox::new();
        assert_eq!(
            write_and_project(&source.0, "local", original)
                .unwrap()
                .cloud_projection,
            "current"
        );
        let mut cloud = read_cloud(&source.0, "local").unwrap().unwrap();
        let mut projections = vec![cloud.clone()];
        let mut restored = Vec::new();
        // Repeated cross-machine-shaped restores use different isolated roots;
        // no relabeling, deleting local canonical, or bypassing restore priority.
        for _ in 0..3 {
            assert_bits(&parse(&cloud).unwrap()["session"].to_string());
            let target = Sandbox::new();
            fs::write(target.dir().join(CLOUD), &cloud).unwrap();
            assert_eq!(
                restore_cloud(&target.0, "local", &cloud, |_| Ok(())).unwrap(),
                "restored"
            );
            let raw = read_session(&target.0, "local").unwrap().unwrap();
            assert_bits(&raw);
            restored.push(raw);
            refresh_cloud(&target.0, "local").unwrap();
            cloud = read_cloud(&target.0, "local").unwrap().unwrap();
            projections.push(cloud.clone());
        }
        results.push(json!({"name":name,"pointBits":fixture["pointBits"],"velocityBits":fixture["velocityBits"],
            "canonical":original,"projections":projections,"restored":restored}));
    }
    // JavaScript now parses every real native-produced file and compares *all*
    // numeric leaves, catching serializer drift that a Rust-only oracle can miss.
    let report = javascript_float_exchange("verify", &Value::Array(results).to_string());
    println!("cross-language float report: {report}");
    assert_eq!(parse(&report).unwrap()["drift"], 0);
}

struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "dc-cloud-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn dir(&self) -> PathBuf {
        profile_dir(&self.0, "local", true).unwrap()
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        // Owned unique test tree, never an app-data or caller-selected directory.
        assert!(self.0.starts_with(std::env::temp_dir()));
        assert!(
            self.0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("dc-cloud-test-")
        );
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn document(marker: u64) -> String {
    let mut value = parse(EMPTY).unwrap();
    value["campaign"]["meta"]["researchPoints"] = json!(marker);
    value.to_string()
}
fn no_temps(dir: &Path) {
    assert!(
        fs::read_dir(dir).unwrap().all(|e| e
            .unwrap()
            .path()
            .extension()
            .is_none_or(|s| s != "tmp"))
    );
}
fn fail_refresh(root: &Path, fail: Stage, occurrence: u32) -> Result<(), String> {
    let _guard = IO_LOCK.lock().unwrap();
    let dir = profile_dir(root, "local", false)?;
    let _lock = process_lock(&dir)?;
    let hits = std::cell::Cell::new(0);
    refresh_locked(&dir, "local", &|stage| {
        if stage == fail {
            hits.set(hits.get() + 1);
            if hits.get() == occurrence {
                return Err("injected cloud I/O failure".into());
            }
        }
        Ok(())
    })
}

#[test]
fn native_projection_strips_legacy_and_preserves_canonical_and_safe_backup() {
    let sandbox = Sandbox::new();
    let mut source = parse(EMPTY).unwrap();
    source["campaign"]["legacyCompanion"] = json!({"saveVersion":3,"source":{"saveVersion":3,"originalPath":"C:\\private\\old.json","desktop":{"pixels":[1,2]},"logs":["private"]}});
    let raw = source.to_string();
    assert_eq!(
        write_and_project(&sandbox.0, "local", &raw)
            .unwrap()
            .cloud_projection,
        "current"
    );
    assert_eq!(read_session(&sandbox.0, "local").unwrap().unwrap(), raw);
    let first = read_cloud(&sandbox.0, "local").unwrap().unwrap();
    for forbidden in ["originalPath", "private", "desktop", "logs", "source"] {
        assert!(!first.contains(forbidden));
    }
    assert!(
        validate_projection("local", &first).unwrap()["session"]["campaign"]["legacyCompanion"]
            .is_null()
    );
    source["campaign"]["meta"]["researchPoints"] = json!(2);
    write_and_project(&sandbox.0, "local", &source.to_string()).unwrap();
    assert_eq!(
        fs::read_to_string(sandbox.dir().join(CLOUD_BACKUP)).unwrap(),
        first
    );
    assert_eq!(fs::read_to_string(sandbox.dir().join(BACKUP)).unwrap(), raw);
    assert!(!sandbox.0.join("campaign-v4/steam-1").exists());
}

#[test]
fn projection_roundtrips_v4_homes_and_bare_v4_migration_without_mutation() {
    for raw in [EMPTY, ACTIVE, HOMES] {
        let before = parse(raw).unwrap();
        let cloud = project_session("local", raw).unwrap();
        assert_eq!(
            validate_projection("local", &cloud.to_string()).unwrap(),
            cloud
        );
        assert_eq!(
            project_session("local", &cloud["session"].to_string()).unwrap(),
            cloud
        );
        assert_eq!(cloud["session"]["s07Homes"], before["s07Homes"]);
        assert_eq!(
            cloud["session"]["campaign"]["meta"],
            before["campaign"]["meta"]
        );
    }
    let bare = parse(EMPTY).unwrap()["campaign"].to_string();
    assert_eq!(
        project_session("local", &bare).unwrap(),
        project_session("local", EMPTY).unwrap()
    );
}

#[test]
fn rejects_unknown_fields_versions_duplicates_paths_and_embedded_objects() {
    let good = project_session("local", ACTIVE).unwrap();
    for pointer in [
        "",
        "/session",
        "/session/campaign/meta",
        "/session/campaign/activeRun",
        "/session/campaign/activeRun/swatter",
        "/session/campaign/activeRun/actors/0/pose",
        "/session/campaign/activeRun/houses/0",
    ] {
        let mut bad = good.clone();
        bad.pointer_mut(pointer).unwrap()["unexpected"] = json!("secret");
        assert!(
            validate_projection("local", &bad.to_string()).is_err(),
            "{pointer}"
        );
    }
    for version in [0, 2, 4, 999] {
        let mut bad = good.clone();
        bad["cloudVersion"] = json!(version);
        assert!(validate_projection("local", &bad.to_string()).is_err());
    }
    assert!(
        validate_projection(
            "local",
            &good.to_string().replacen(
                "\"cloudVersion\":1",
                "\"cloudVersion\":0,\"cloudVersion\":1",
                1
            )
        )
        .is_err()
    );
    for text in [
        "C:\\private",
        "C:private",
        "file:private",
        "/home/user",
        "../private",
        "https://private",
        "desktop text",
        "秘密",
        "[\"id\",{\"logs\":\"secret\"}]",
        "[\"id\",{\"x\":900,\"y\":0}]",
    ] {
        let mut bad = good.clone();
        bad["session"]["campaign"]["meta"]["appearanceId"] = json!(text);
        assert!(
            validate_projection("local", &bad.to_string()).is_err(),
            "{text}"
        );
    }
    let mut bad = good.clone();
    bad["session"]["campaign"]["legacyCompanion"] =
        json!({"saveVersion":1,"source":{"saveVersion":1}});
    assert!(validate_projection("local", &bad.to_string()).is_err());
}

#[test]
fn reject_byte_collection_and_encoded_json_depth_limits() {
    assert!(validate_projection("local", &" ".repeat(MAX_BYTES + 1)).is_err());
    let mut bad = project_session("local", EMPTY).unwrap();
    bad["session"]["campaign"]["meta"]["settledRunIds"] =
        Value::Array((0..10_001).map(|i| json!(format!("run-{i}"))).collect());
    assert!(validate_projection("local", &bad.to_string()).is_err());
    let mut nested = json!(0);
    for _ in 0..34 {
        nested = json!([nested]);
    }
    assert!(cloud_text(&nested.to_string(), 0, &mut 0).is_err());
    assert!(
        cloud_text(
            "[\"campaign-agent\",\"run-1\",\"actor.frog\",\"capture\",20]",
            0,
            &mut 0
        )
        .is_ok()
    );
    assert!(cloud_text("[\"[\\\"campaign-agent\\\",1]\",\"home\"]", 0, &mut 0).is_ok());
}

#[test]
fn transient_gesture_geometry_is_removed_and_downloads_must_be_normalized() {
    let mut source = parse(ACTIVE).unwrap();
    source["campaign"]["activeRun"]["pauseReasons"] = json!(["user", "display-migration"]);
    source["campaign"]["activeRun"]["swatter"]["start"] = json!({"x":1920,"y":1080});
    let projected = project_session("local", &source.to_string()).unwrap();
    assert_eq!(
        projected["session"]["campaign"]["activeRun"]["pauseReasons"],
        json!(["user"])
    );
    assert_eq!(
        projected["session"]["campaign"]["activeRun"]["swatter"]["start"],
        json!({"x":0,"y":0})
    );
    let mut bad = projected;
    bad["session"]["campaign"]["activeRun"]["swatter"]["start"]["x"] = json!(1);
    assert!(validate_projection("local", &bad.to_string()).is_err());
}

#[test]
fn every_projection_atomic_failure_keeps_canonical_and_previous_complete_cloud() {
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
        write_and_project(&sandbox.0, "local", &document(1)).unwrap();
        let prior = read_cloud(&sandbox.0, "local").unwrap().unwrap();
        write_session(&sandbox.0, "local", &document(2)).unwrap();
        assert!(fail_refresh(&sandbox.0, failing, 1).is_err());
        assert_eq!(read_cloud(&sandbox.0, "local").unwrap().unwrap(), prior);
        assert_eq!(
            read_session(&sandbox.0, "local").unwrap().unwrap(),
            document(2)
        );
        no_temps(&sandbox.dir());
        refresh_cloud(&sandbox.0, "local").unwrap();
        assert_eq!(
            parse(&read_cloud(&sandbox.0, "local").unwrap().unwrap()).unwrap(),
            project_session("local", &document(2)).unwrap()
        );
    }
}

#[test]
fn backup_staging_failure_preserves_prior_backup_and_projection() {
    for stage in [
        Stage::TempCreated,
        Stage::TempWritten,
        Stage::TempFlushed,
        Stage::TempSynced,
    ] {
        let sandbox = Sandbox::new();
        write_and_project(&sandbox.0, "local", &document(1)).unwrap();
        write_and_project(&sandbox.0, "local", &document(2)).unwrap();
        let backup = fs::read_to_string(sandbox.dir().join(CLOUD_BACKUP)).unwrap();
        let prior = read_cloud(&sandbox.0, "local").unwrap().unwrap();
        write_session(&sandbox.0, "local", &document(3)).unwrap();
        assert!(fail_refresh(&sandbox.0, stage, 2).is_err());
        assert_eq!(
            fs::read_to_string(sandbox.dir().join(CLOUD_BACKUP)).unwrap(),
            backup
        );
        assert_eq!(read_cloud(&sandbox.0, "local").unwrap().unwrap(), prior);
        no_temps(&sandbox.dir());
    }
}

#[test]
fn actual_locked_projection_reports_pending_after_canonical_commit_and_repairs() {
    let sandbox = Sandbox::new();
    write_and_project(&sandbox.0, "local", &document(1)).unwrap();
    let held = OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(sandbox.dir().join(CLOUD))
        .unwrap();
    assert_eq!(
        write_and_project(&sandbox.0, "local", &document(2)).unwrap(),
        CheckpointResult {
            canonical_committed: true,
            cloud_projection: "pending"
        }
    );
    assert_eq!(
        read_session(&sandbox.0, "local").unwrap().unwrap(),
        document(2)
    );
    drop(held);
    refresh_cloud(&sandbox.0, "local").unwrap();
    assert_eq!(
        parse(&read_cloud(&sandbox.0, "local").unwrap().unwrap()).unwrap(),
        project_session("local", &document(2)).unwrap()
    );
}

#[test]
fn competing_checkpoints_project_latest_canonical_under_shared_transaction_locks() {
    let sandbox = Sandbox::new();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let writers: Vec<_> = (0..8)
        .map(|marker| {
            let root = sandbox.0.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                for revision in 0..3 {
                    assert_eq!(
                        write_and_project(&root, "local", &document(marker * 3 + revision))
                            .unwrap()
                            .cloud_projection,
                        "current"
                    );
                }
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }
    let canonical = read_session(&sandbox.0, "local").unwrap().unwrap();
    let cloud = read_cloud(&sandbox.0, "local").unwrap().unwrap();
    assert_eq!(
        parse(&cloud).unwrap(),
        project_session("local", &canonical).unwrap()
    );
    validate_projection(
        "local",
        &fs::read_to_string(sandbox.dir().join(CLOUD_BACKUP)).unwrap(),
    )
    .unwrap();
    no_temps(&sandbox.dir());
}

#[test]
fn corrupt_future_or_unsafe_cloud_is_never_backed_up_or_implicitly_repaired() {
    for raw in [
        "{",
        "{\"cloudVersion\":2,\"session\":{}}",
        "{\"legacyCompanion\":{\"source\":{}}}",
    ] {
        let sandbox = Sandbox::new();
        let dir = sandbox.dir();
        fs::write(dir.join(CLOUD), raw).unwrap();
        assert_eq!(
            write_and_project(&sandbox.0, "local", EMPTY)
                .unwrap()
                .cloud_projection,
            "pending"
        );
        assert_eq!(fs::read_to_string(dir.join(CLOUD)).unwrap(), raw);
        assert!(!dir.join(CLOUD_BACKUP).exists());
        assert!(read_cloud(&sandbox.0, "local").is_err());
        assert!(refresh_cloud(&sandbox.0, "local").is_err());
    }
}

#[test]
fn invalid_existing_cloud_backup_blocks_refresh_even_when_main_is_current() {
    let sandbox = Sandbox::new();
    write_and_project(&sandbox.0, "local", EMPTY).unwrap();
    let cloud = read_cloud(&sandbox.0, "local").unwrap();
    fs::write(sandbox.dir().join(CLOUD_BACKUP), "future-or-broken").unwrap();
    assert!(refresh_cloud(&sandbox.0, "local").is_err());
    assert_eq!(read_cloud(&sandbox.0, "local").unwrap(), cloud);
    assert_eq!(
        fs::read_to_string(sandbox.dir().join(CLOUD_BACKUP)).unwrap(),
        "future-or-broken"
    );
}

#[test]
fn frozen_contract_matches_native_cloud_envelope_files_and_limits() {
    let contract = parse(include_str!("../../release/steam/cloud-save-contract.json")).unwrap();
    assert_eq!(contract["contractVersion"], 2);
    assert_eq!(contract["files"]["cloudMain"], CLOUD);
    assert_eq!(contract["files"]["cloudBackup"], CLOUD_BACKUP);
    assert_eq!(contract["files"]["cycleV1Original"], CYCLE_V1);
    assert!(
        contract["autoCloud"]["exclude"]
            .as_array()
            .unwrap()
            .contains(&json!(CYCLE_V1))
    );
    assert_eq!(contract["autoCloud"]["pattern"], CLOUD);
    assert_eq!(contract["cloudDocument"]["cloudVersion"], 1);
    assert_eq!(contract["cloudDocument"]["maxUtf8Bytes"], MAX_BYTES);
    assert_eq!(contract["autoCloud"]["enabled"], false);
}

#[test]
fn restore_missing_only_never_merges_or_replays_settlement_and_checks_download_bytes() {
    let sandbox = Sandbox::new();
    let dir = sandbox.dir();
    let mut source = parse(EMPTY).unwrap();
    source["campaign"]["meta"]["settledRunIds"] = json!(["settled-1"]);
    source["campaign"]["recentSettlement"] = json!({"runId":"settled-1","missionId":"demo-1","outcome":"abandoned","researchReward":0,"score":0,"breakdown":{"base":0,"milestones":0,"firstVictory":0,"firstAttempt":0}});
    let cloud = project_session("local", &source.to_string())
        .unwrap()
        .to_string();
    assert!(restore_cloud(&sandbox.0, "local", &cloud, |_| Ok(())).is_err());
    fs::write(dir.join(CLOUD), &cloud).unwrap();
    assert!(restore_cloud(&sandbox.0, "local", &format!("{cloud}\n"), |_| Ok(())).is_err());
    assert!(!dir.join(MAIN).exists());
    assert_eq!(
        restore_cloud(&sandbox.0, "local", &cloud, |_| Ok(())).unwrap(),
        "restored"
    );
    let restored = read_session(&sandbox.0, "local").unwrap().unwrap();
    assert_eq!(parse(&restored).unwrap(), source);
    for _ in 0..3 {
        assert_eq!(
            restore_cloud(&sandbox.0, "local", &cloud, |_| Ok(())).unwrap(),
            "local-present"
        );
    }
    assert_eq!(
        read_session(&sandbox.0, "local").unwrap().unwrap(),
        restored
    );
    assert!(!dir.join(BACKUP).exists());
}

#[test]
fn all_existing_local_main_and_every_local_backup_win_even_corrupt_or_future() {
    for name in [MAIN, BACKUP, LEGACY, CYCLE_V1] {
        for local in [
            document(100),
            "{\"sessionVersion\":99}".into(),
            "broken".into(),
        ] {
            let sandbox = Sandbox::new();
            let dir = sandbox.dir();
            let cloud = project_session("local", &document(1)).unwrap().to_string();
            fs::write(dir.join(CLOUD), &cloud).unwrap();
            fs::write(dir.join(name), &local).unwrap();
            assert_eq!(
                restore_cloud(&sandbox.0, "local", &cloud, |_| Ok(())).unwrap(),
                "local-present"
            );
            assert_eq!(fs::read_to_string(dir.join(name)).unwrap(), local);
            if name != MAIN {
                assert!(!dir.join(MAIN).exists());
            }
        }
    }
}

#[test]
fn failed_restore_never_creates_partial_canonical_or_uses_cloud_backup() {
    for stage in [
        Stage::TempCreated,
        Stage::TempWritten,
        Stage::TempFlushed,
        Stage::TempSynced,
        Stage::BeforePublish,
    ] {
        let sandbox = Sandbox::new();
        let dir = sandbox.dir();
        let cloud = project_session("local", EMPTY).unwrap().to_string();
        fs::write(dir.join(CLOUD_BACKUP), &cloud).unwrap();
        assert!(restore_cloud(&sandbox.0, "local", &cloud, |_| Ok(())).is_err());
        fs::write(dir.join(CLOUD), &cloud).unwrap();
        assert!(
            restore_cloud(&sandbox.0, "local", &cloud, |s| if s == stage {
                Err("fault".into())
            } else {
                Ok(())
            })
            .is_err()
        );
        assert!(!dir.join(MAIN).exists());
        no_temps(&dir);
    }
}

#[test]
fn profile_auth_traversal_alias_and_u64_are_separate_gates() {
    let sandbox = Sandbox::new();
    for profile in [
        "../local",
        "steam:1/..",
        "local:ads",
        "steam:01",
        "steam:0",
        "steam:18446744073709551616",
    ] {
        assert!(read_cloud(&sandbox.0, profile).is_err());
        assert!(refresh_cloud(&sandbox.0, profile).is_err());
    }
    for profile in ["steam:1", "steam:18446744073709551615"] {
        assert!(cloud_profile(profile).is_ok());
        assert!(authorize_request(crate::window_manager::OVERLAY_LABEL, profile).is_err());
    }
    assert!(authorize_request("settings", "local").is_err());
    assert_eq!(read_cloud(&sandbox.0, "local").unwrap(), None);
    assert_eq!(fs::read_dir(&sandbox.0).unwrap().count(), 0);
}

#[test]
fn junction_and_wrong_cloud_nodes_cannot_escape_or_erase_files() {
    let sandbox = Sandbox::new();
    let outside = Sandbox::new();
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
    assert!(read_cloud(&sandbox.0, "local").is_err());
    assert!(refresh_cloud(&sandbox.0, "local").is_err());
    assert!(
        restore_cloud(
            &sandbox.0,
            "local",
            &project_session("local", EMPTY).unwrap().to_string(),
            |_| Ok(())
        )
        .is_err()
    );
    assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 0);
    fs::remove_dir(&junction).unwrap();
    let dir = sandbox.dir();
    fs::create_dir(dir.join(CLOUD)).unwrap();
    assert_eq!(
        write_and_project(&sandbox.0, "local", EMPTY)
            .unwrap()
            .cloud_projection,
        "pending"
    );
    assert!(dir.join(CLOUD).is_dir());
}

#[test]
fn subprocess_cloud_worker() {
    let Some(root) = std::env::var_os("DC_CLOUD_TEST_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let cloud = fs::read_to_string(root.join("campaign-v4/local").join(CLOUD)).unwrap();
    let result = restore_cloud(&root, "local", &cloud, |_| Ok(()));
    match std::env::var("DC_CLOUD_TEST_RESULT").unwrap().as_str() {
        "blocked" => {
            assert!(result.is_err());
            assert!(read_cloud(&root, "local").is_err());
        }
        expected => assert_eq!(result.unwrap(), expected),
    }
}

#[test]
fn real_process_lock_and_restart_replay_preserve_one_canonical() {
    let sandbox = Sandbox::new();
    let dir = sandbox.dir();
    let cloud = project_session("local", EMPTY).unwrap().to_string();
    fs::write(dir.join(CLOUD), &cloud).unwrap();
    let child = |expected: &str| {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "campaign_storage::cloud::tests::subprocess_cloud_worker",
                "--nocapture",
            ])
            .env("DC_CLOUD_TEST_ROOT", &sandbox.0)
            .env("DC_CLOUD_TEST_RESULT", expected)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    };
    let held = process_lock(&dir).unwrap();
    child("blocked");
    assert!(!dir.join(MAIN).exists());
    drop(held);
    child("restored");
    let original = fs::read_to_string(dir.join(MAIN)).unwrap();
    child("local-present");
    assert_eq!(fs::read_to_string(dir.join(MAIN)).unwrap(), original);
    no_temps(&dir);
}
