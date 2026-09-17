//! Native structural boundary for the existing TypeScript V4 format.
//! P2: economic conservation, derived upgrade attributes, reward/command provenance,
//! and complete combat/terminal cross-validation remain in validateGameSaveV4.
//! This validator is deliberately not a second implementation of the simulation.
use super::{exact, invalid, safe_integer};
use serde_json::{Map, Value};
use std::collections::HashSet;

const SAFE_MAX: f64 = 9_007_199_254_740_991.0;
const SAFE_MAX_INTEGER: u64 = 9_007_199_254_740_991;
type Checked = Result<(), String>;

fn require(condition: bool, reason: &str) -> Checked {
    if condition {
        Ok(())
    } else {
        Err(invalid(reason))
    }
}
fn ident(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 512)
}
fn meaningful(value: &Value) -> bool {
    ident(value) && value.as_str().is_some_and(|s| !s.trim().is_empty())
}
fn number(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n >= 0.0 && n <= SAFE_MAX)
}
fn member(value: &Value, names: &[&str]) -> bool {
    value.as_str().is_some_and(|s| names.contains(&s))
}
fn array(value: &Value, limit: usize) -> Result<&Vec<Value>, String> {
    value
        .as_array()
        .filter(|a| a.len() <= limit)
        .ok_or_else(|| invalid("集合类型或上限"))
}
fn map(value: &Value, limit: usize) -> Result<&Map<String, Value>, String> {
    value
        .as_object()
        .filter(|a| a.len() <= limit)
        .ok_or_else(|| invalid("映射类型或上限"))
}
fn unique_ids(value: &Value, limit: usize, trim: bool) -> Result<HashSet<&str>, String> {
    let mut seen = HashSet::new();
    for value in array(value, limit)? {
        require(
            if trim {
                meaningful(value)
            } else {
                ident(value)
            },
            "ID 类型或长度",
        )?;
        require(seen.insert(value.as_str().unwrap()), "重复 ID")?;
    }
    Ok(seen)
}
fn research(value: &Value) -> Result<HashSet<&str>, String> {
    let nodes = unique_ids(value, 24, true)?;
    for node in &nodes {
        let (branch, tier) = node.rsplit_once('-').ok_or_else(|| invalid("研究节点"))?;
        require(
            ["cleaner", "frog", "bag", "swat", "trap", "home"].contains(&branch)
                && ["1", "2", "3", "4"].contains(&tier),
            "研究节点",
        )?;
        let tier: u8 = tier.parse().map_err(|_| invalid("研究层级"))?;
        require(
            tier == 1 || nodes.contains(format!("{branch}-{}", tier - 1).as_str()),
            "研究先决条件",
        )?;
    }
    Ok(nodes)
}
fn point(value: &Value, normalized: bool) -> Checked {
    require(
        number(&value["x"])
            && number(&value["y"])
            && (!normalized
                || (value["x"].as_f64().unwrap() <= 1.0 && value["y"].as_f64().unwrap() <= 1.0)),
        "坐标",
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EcologySchema {
    Legacy,
    Cycle2,
}

pub(super) fn validate_campaign(profile: &str, campaign: &Value) -> Checked {
    validate_campaign_schema(profile, campaign, EcologySchema::Cycle2)
}

pub(super) fn validate_campaign_previous(profile: &str, campaign: &Value) -> Checked {
    let schema = match campaign["activeRun"].as_object() {
        Some(run)
            if run
                .get("ecology")
                .and_then(Value::as_object)
                .is_some_and(|ecology| ecology.contains_key("cycleVersion")) =>
        {
            EcologySchema::Cycle2
        }
        Some(_) => EcologySchema::Legacy,
        None => EcologySchema::Cycle2,
    };
    validate_campaign_schema(profile, campaign, schema)
}

fn validate_campaign_schema(profile: &str, campaign: &Value, schema: EcologySchema) -> Checked {
    super::profile_component(profile)?;
    exact(
        campaign,
        &[
            "saveVersion",
            "profile",
            "meta",
            "activeRun",
            "recentSettlement",
            "legacyCompanion",
        ],
    )?;
    require(
        safe_integer(&campaign["saveVersion"]) == Some(4)
            && campaign["profile"].as_str() == Some(profile),
        "V4 版本或 profile",
    )?;
    let meta = &campaign["meta"];
    exact(
        meta,
        &[
            "researchPoints",
            "nodes",
            "completedMissions",
            "firstAttemptGranted",
            "settledRunIds",
            "frogUnlocked",
            "appearanceId",
        ],
    )?;
    require(
        safe_integer(&meta["researchPoints"]).is_some()
            && meta["firstAttemptGranted"].is_boolean()
            && meta["frogUnlocked"].is_boolean()
            && meaningful(&meta["appearanceId"]),
        "局外进度类型",
    )?;
    let nodes = research(&meta["nodes"])?;
    let missions = unique_ids(&meta["completedMissions"], 10_000, true)?;
    let settled = unique_ids(&meta["settledRunIds"], 10_000, true)?;
    let run = &campaign["activeRun"];
    if !run.is_null() {
        validate_run(run, schema)?;
        require(research(&run["researchNodes"])? == nodes, "局内研究快照")?;
    }
    let result = &campaign["recentSettlement"];
    if !result.is_null() {
        settlement(result)?;
        require(
            settled.contains(result["runId"].as_str().unwrap()),
            "结算运行标记",
        )?;
        require(
            result["outcome"] != "victory"
                || missions.contains(result["missionId"].as_str().unwrap()),
            "通关标记",
        )?;
        require(
            result["score"].as_f64().unwrap() < 20.0 || meta["firstAttemptGranted"] == true,
            "首次尝试标记",
        )?;
    }
    if !run.is_null() {
        if member(&run["phase"], &["victory", "defeat", "abandoned"]) {
            require(
                !result.is_null()
                    && result["runId"] == run["runId"]
                    && result["missionId"] == run["missionId"]
                    && result["outcome"] == run["phase"],
                "终局结算身份",
            )?;
        } else {
            require(
                !settled.contains(run["runId"].as_str().unwrap()),
                "已结算的活动运行",
            )?;
        }
    }
    let legacy = &campaign["legacyCompanion"];
    if !legacy.is_null() {
        exact(legacy, &["saveVersion", "source"])?;
        require(
            matches!(safe_integer(&legacy["saveVersion"]), Some(1..=3))
                && legacy["source"].is_object()
                && safe_integer(&legacy["source"]["saveVersion"])
                    == safe_integer(&legacy["saveVersion"]),
            "旧陪伴版本",
        )?;
    }
    Ok(())
}

fn settlement(value: &Value) -> Checked {
    exact(
        value,
        &[
            "runId",
            "missionId",
            "outcome",
            "researchReward",
            "score",
            "breakdown",
        ],
    )?;
    require(
        meaningful(&value["runId"])
            && meaningful(&value["missionId"])
            && member(&value["outcome"], &["victory", "defeat", "abandoned"])
            && safe_integer(&value["researchReward"]).is_some()
            && number(&value["score"]),
        "结算类型",
    )?;
    let breakdown = &value["breakdown"];
    exact(
        breakdown,
        &["base", "milestones", "firstVictory", "firstAttempt"],
    )?;
    let base = safe_integer(&breakdown["base"]).ok_or_else(|| invalid("结算基础奖励"))?;
    let milestones = safe_integer(&breakdown["milestones"]).ok_or_else(|| invalid("结算里程碑"))?;
    let victory =
        safe_integer(&breakdown["firstVictory"]).ok_or_else(|| invalid("首次通关奖励"))?;
    let attempt =
        safe_integer(&breakdown["firstAttempt"]).ok_or_else(|| invalid("首次尝试奖励"))?;
    let score = value["score"].as_f64().unwrap();
    require(
        base == (score / 40.0).floor().min(6.0) as u64
            && milestones <= 3
            && [0, 8].contains(&victory)
            && [0, 3].contains(&attempt)
            && (victory == 0 || value["outcome"] == "victory")
            && (attempt == 0 || score >= 20.0),
        "结算奖励结构",
    )?;
    require(
        safe_integer(&value["researchReward"]) == Some(base + milestones + victory + attempt),
        "结算奖励总额",
    )
}

fn validate_run(run: &Value, schema: EcologySchema) -> Checked {
    exact(
        run,
        &[
            "runId",
            "missionId",
            "phase",
            "pauseReasons",
            "tick",
            "ecology",
            "inventory",
            "economy",
            "upgrades",
            "researchNodes",
            "actors",
            "houses",
            "traps",
            "trapSlots",
            "retreatSeconds",
            "pressureSeconds",
            "victorySeconds",
            "swatter",
            "frogUnlocked",
        ],
    )?;
    require(
        ident(&run["runId"])
            && ident(&run["missionId"])
            && member(
                &run["phase"],
                &[
                    "preparation",
                    "running",
                    "retreat",
                    "siege",
                    "victory",
                    "defeat",
                    "abandoned",
                ],
            )
            && safe_integer(&run["tick"]).is_some()
            && run["frogUnlocked"].is_boolean(),
        "运行身份或时钟",
    )?;
    unique_ids(&run["pauseReasons"], 50_000, false)?;
    research(&run["researchNodes"])?;
    for key in ["retreatSeconds", "pressureSeconds", "victorySeconds"] {
        require(number(&run[key]), "运行计时")?;
    }
    require(
        safe_integer(&run["trapSlots"]).is_some_and(|n| (3..=5).contains(&n)),
        "陷阱栏位",
    )?;
    inventory(&run["inventory"], schema)?;
    economy(&run["economy"], schema)?;
    if schema == EcologySchema::Cycle2 {
        dispositions(run)?;
    }
    ecology(&run["ecology"], schema)?;
    exact(&run["upgrades"], &["levels"])?;
    for (key, level) in map(&run["upgrades"]["levels"], 14)? {
        require(
            [
                "cleanerClean",
                "cleanerMove",
                "cleanerCapacity",
                "frogTongue",
                "frogAttack",
                "frogDigestion",
                "frogBatch",
                "frogCapacity",
                "bagCapacity",
                "bagEfficiency",
                "swatDamage",
                "swatHeat",
                "trapMaintenance",
                "homeArmor",
            ]
            .contains(&key.as_str())
                && safe_integer(level).is_some_and(|n| n <= 3),
            "局内升级",
        )?;
    }
    residents(run)?;
    if schema == EcologySchema::Cycle2 {
        retired(run)?;
    }
    let mut trap_ids = HashSet::new();
    let mut ladders = 0;
    let traps = array(&run["traps"], 6)?;
    for trap in traps {
        exact(
            trap,
            &[
                "id",
                "kind",
                "x",
                "y",
                "remaining",
                "uses",
                "paid",
                "purchaseCommandId",
                "inventoryId",
            ],
        )?;
        point(trap, true)?;
        require(
            ident(&trap["id"])
                && trap_ids.insert(trap["id"].as_str().unwrap())
                && member(&trap["kind"], &["bait", "glue", "catcher", "ladder"])
                && trap["y"].as_f64() == Some(1.0)
                && number(&trap["remaining"])
                && safe_integer(&trap["uses"]).is_some()
                && safe_integer(&trap["paid"]).is_some()
                && ident(&trap["purchaseCommandId"]),
            "陷阱结构",
        )?;
        require(
            if trap["kind"] == "catcher" {
                trap["inventoryId"] == trap["id"]
                    && run["inventory"]["containers"][trap["id"].as_str().unwrap()]["kind"]
                        == "trap"
            } else {
                trap["inventoryId"].is_null()
            },
            "陷阱背包",
        )?;
        if trap["kind"] == "ladder" {
            ladders += 1;
        }
    }
    require(
        ladders <= 1 && traps.len() - ladders <= safe_integer(&run["trapSlots"]).unwrap() as usize,
        "陷阱数量",
    )?;
    let swatter = &run["swatter"];
    exact(
        swatter,
        &[
            "active",
            "gestureId",
            "start",
            "end",
            "path",
            "hitIds",
            "cooldown",
            "heat",
            "overheated",
        ],
    )?;
    require(
        swatter["active"].is_boolean()
            && swatter["gestureId"].is_string()
            && swatter["overheated"].is_boolean()
            && number(&swatter["cooldown"])
            && swatter["cooldown"].as_f64().unwrap() <= 0.25
            && number(&swatter["heat"]),
        "拍子结构",
    )?;
    unique_ids(&swatter["hitIds"], 10_000, false)?;
    for p in [&swatter["start"], &swatter["end"]]
        .into_iter()
        .chain(array(&swatter["path"], 2048)?)
    {
        exact(p, &["x", "y"])?;
        point(p, false)?;
    }
    Ok(())
}

fn residents(run: &Value) -> Checked {
    let houses = array(&run["houses"], 2)?;
    let actors = array(&run["actors"], 2)?;
    require(houses.len() == 2 && actors.len() == 2, "双角色双屋")?;
    let mut house_ids = HashSet::new();
    for house in houses {
        exact(
            house,
            &["id", "x", "y", "hp", "maxHp", "repaired", "locked"],
        )?;
        point(house, true)?;
        require(
            ident(&house["id"])
                && house_ids.insert(house["id"].as_str().unwrap())
                && number(&house["hp"])
                && number(&house["maxHp"])
                && house["maxHp"].as_f64().unwrap() > 0.0
                && house["hp"].as_f64().unwrap() <= house["maxHp"].as_f64().unwrap()
                && house["repaired"].is_boolean()
                && house["locked"].is_boolean(),
            "房屋结构",
        )?;
        require(
            run["inventory"]["containers"][house["id"].as_str().unwrap()]["kind"] == "house",
            "房屋容器",
        )?;
        require(
            !member(&run["phase"], &["retreat", "siege"]) || house["locked"] == true,
            "撤退锁屋",
        )?;
    }
    let mut actor_ids = HashSet::new();
    let mut resident_homes = HashSet::new();
    let mut packs = HashSet::new();
    let mut roles = HashSet::new();
    for actor in actors {
        exact(
            actor,
            &[
                "id",
                "archetype",
                "inventoryId",
                "houseId",
                "atHome",
                "pose",
            ],
        )?;
        require(
            ident(&actor["id"])
                && actor_ids.insert(actor["id"].as_str().unwrap())
                && member(&actor["archetype"], &["cleaner", "frog"])
                && roles.insert(actor["archetype"].as_str().unwrap())
                && ident(&actor["inventoryId"])
                && packs.insert(actor["inventoryId"].as_str().unwrap())
                && ident(&actor["houseId"])
                && resident_homes.insert(actor["houseId"].as_str().unwrap())
                && house_ids.contains(actor["houseId"].as_str().unwrap())
                && actor["atHome"].is_boolean(),
            "角色身份",
        )?;
        let kind = if actor["archetype"] == "frog" {
            "frogPouch"
        } else {
            "cleanerPack"
        };
        require(
            run["inventory"]["containers"][actor["inventoryId"].as_str().unwrap()]["kind"] == kind,
            "角色背包",
        )?;
        let pose = &actor["pose"];
        exact(
            pose,
            &[
                "x",
                "y",
                "vx",
                "vy",
                "stamina",
                "appearanceId",
                "activity",
                "motion",
                "taskId",
            ],
        )?;
        point(pose, true)?;
        require(
            ["vx", "vy"]
                .iter()
                .all(|key| pose[key].as_f64().is_some_and(f64::is_finite))
                && number(&pose["stamina"])
                && pose["stamina"].as_f64().unwrap() <= 100.0
                && ident(&pose["appearanceId"])
                && member(
                    &pose["activity"],
                    &[
                        "idle",
                        "travelling",
                        "working",
                        "returning-home",
                        "entering-home",
                        "resting",
                        "exiting-home",
                        "unavailable",
                    ],
                )
                && member(
                    &pose["motion"],
                    &["walking", "climbing", "jumping", "falling", "landing"],
                )
                && (pose["taskId"].is_null()
                    || (ident(&pose["taskId"])
                        && run["inventory"]["objects"]
                            .get(pose["taskId"].as_str().unwrap())
                            .is_some())),
            "角色姿态",
        )?;
        require(
            run["phase"] != "siege" || actor["atHome"] == true,
            "守家居民",
        )?;
    }
    Ok(())
}

fn ecology(value: &Value, schema: EcologySchema) -> Checked {
    let mut fields = vec![
        "stage",
        "seconds",
        "pollution",
        "density",
        "peakDensity",
        "seed",
        "nextId",
        "spawnRemaining",
        "nestSpawned",
        "nestDestroyed",
    ];
    if schema == EcologySchema::Cycle2 {
        fields.extend(["cycleVersion", "openingSpawned"]);
    }
    exact(value, &fields)?;
    require(
        safe_integer(&value["stage"]).is_some_and(|n| (1..=4).contains(&n))
            && safe_integer(&value["seed"]).is_some_and(|n| n <= u32::MAX as u64)
            && safe_integer(&value["nextId"]).is_some_and(|n| n > 0 && n < SAFE_MAX as u64)
            && number(&value["seconds"])
            && number(&value["spawnRemaining"]),
        "生态时钟",
    )?;
    for key in ["pollution", "density", "peakDensity"] {
        require(
            number(&value[key]) && value[key].as_f64().unwrap() <= 100.0,
            "生态指标",
        )?;
    }
    require(
        value["nestSpawned"].is_boolean()
            && value["nestDestroyed"].is_boolean()
            && (value["nestDestroyed"] != true || value["nestSpawned"] == true),
        "虫巢标记",
    )?;
    if schema == EcologySchema::Cycle2 {
        require(
            safe_integer(&value["cycleVersion"]) == Some(2) && value["openingSpawned"].is_boolean(),
            "生态循环版本",
        )?;
    }
    Ok(())
}

fn entity_ecology(item: &Value, objects: &Map<String, Value>) -> Checked {
    let value = &item["ecology"];
    let mut fields = vec![
        "stage",
        "sex",
        "energy",
        "growthSeconds",
        "breedCooldown",
        "mated",
        "food",
        "carrierId",
        "wanderX",
        "wanderY",
        "wanderRemaining",
        "wanderSeed",
        "heading",
        "disposition",
    ];
    let has_action = value.get("action").is_some();
    if has_action {
        fields.extend(["action", "actionElapsed", "actionTargetId"]);
    }
    exact(value, &fields)?;
    require(
        member(
            &value["stage"],
            &["none", "egg", "small", "medium", "adult"],
        ) && member(&value["sex"], &["none", "male", "female"])
            && value["mated"].is_boolean()
            && member(
                &value["disposition"],
                &["none", "consumed", "carrier-cleared"],
            )
            && value["heading"].as_f64().is_some_and(f64::is_finite)
            && safe_integer(&value["wanderSeed"]).is_some_and(|n| n <= u32::MAX as u64),
        "物品生态身份",
    )?;
    for field in [
        "energy",
        "growthSeconds",
        "breedCooldown",
        "food",
        "wanderX",
        "wanderY",
        "wanderRemaining",
    ] {
        require(number(&value[field]), "物品生态数值")?;
    }
    require(
        value["energy"].as_f64().unwrap() <= 100.0
            && value["wanderX"].as_f64().unwrap() <= 1.0
            && value["wanderY"].as_f64().unwrap() <= 1.0,
        "物品生态范围",
    )?;
    let stage = value["stage"].as_str().unwrap();
    let sex = value["sex"].as_str().unwrap();
    let kind = item["kind"].as_str().unwrap();
    let adult_body =
        matches!(stage, "small" | "medium" | "adult") && matches!(sex, "male" | "female");
    require(
        (kind == "trash" && stage == "none" && sex == "none")
            || (kind == "egg" && stage == "egg" && matches!(sex, "male" | "female"))
            || (matches!(kind, "bug" | "elite") && adult_body)
            || (kind == "corpse" && ((stage == "none" && sex == "none") || adult_body))
            || (kind == "nest" && stage == "none" && sex == "none"),
        "物品生态 kind/stage/sex",
    )?;
    if has_action {
        let action = value["action"]
            .as_str()
            .ok_or_else(|| invalid("物品生态动作字段"))?;
        let action_elapsed = value["actionElapsed"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .ok_or_else(|| invalid("物品生态动作字段"))?;
        let target_id = value["actionTargetId"].as_str();
        require(
            matches!(action, "feeding" | "mating" | "laying")
                && (value["actionTargetId"].is_null()
                    || target_id.is_some_and(|target_id| ident(&Value::String(target_id.into()))))
                && matches!(kind, "bug" | "elite")
                && item["owner"] == "world"
                && item["hp"].as_f64().is_some_and(|hp| hp > 0.0)
                && value["disposition"] == "none",
            "物品生态动作字段",
        )?;
        match action {
            "feeding" => {
                let target_id = target_id.ok_or_else(|| invalid("物品生态进食动作"))?;
                require(
                    target_id != item["id"].as_str().unwrap(),
                    "物品生态进食动作",
                )?;
            }
            "mating" => {
                let target_id = target_id.ok_or_else(|| invalid("物品生态交配动作"))?;
                require(
                    action_elapsed <= 4.0
                        && stage == "adult"
                        && target_id != item["id"].as_str().unwrap(),
                    "物品生态交配动作",
                )?;
            }
            "laying" => require(
                action_elapsed <= 3.0
                    && stage == "adult"
                    && sex == "female"
                    && value["mated"] == true,
                "物品生态产卵动作",
            )?,
            _ => unreachable!(),
        }
    }
    if let Some(carrier_id) = value["carrierId"].as_str() {
        let carrier = objects
            .get(carrier_id)
            .ok_or_else(|| "物品生态携带者".to_string())?;
        require(
            ident(&value["carrierId"])
                && kind == "egg"
                && item["owner"] == "world"
                && carrier["kind"] == "trash"
                && carrier["owner"] == "world",
            "物品生态携带者",
        )?;
    } else {
        require(value["carrierId"].is_null(), "物品生态携带者")?;
    }
    if kind == "corpse" {
        require(
            value["energy"].as_f64() == Some(0.0)
                && value["mated"] == false
                && value["breedCooldown"].as_f64() == Some(0.0),
            "尸体生态",
        )?;
    }
    let system_inactive = item["owner"] == "disposed"
        && value["food"].as_f64() == Some(0.0)
        && value["carrierId"].is_null()
        && value["energy"].as_f64() == Some(0.0)
        && value["mated"] == false
        && value["breedCooldown"].as_f64() == Some(0.0);
    require(
        value["disposition"] == "none"
            || (value["disposition"] == "consumed"
                && system_inactive
                && matches!(kind, "trash" | "corpse"))
            || (value["disposition"] == "carrier-cleared" && system_inactive && kind == "egg"),
        "物品生态系统处置",
    )?;
    Ok(())
}

fn dispositions(run: &Value) -> Checked {
    let events = run["economy"]["events"]
        .as_array()
        .ok_or_else(|| "经济事件".to_string())?;
    for item in run["inventory"]["objects"]
        .as_object()
        .ok_or_else(|| "物品".to_string())?
        .values()
    {
        if item["owner"] != "disposed" {
            continue;
        }
        if member(
            &item["ecology"]["disposition"],
            &["consumed", "carrier-cleared"],
        ) {
            require(
                !events
                    .iter()
                    .any(|event| event["kind"] == "clean" && event["targetId"] == item["id"]),
                "系统处置不得产生清理收益",
            )?;
        } else {
            let expected = format!("clean:{}", item["id"].as_str().unwrap());
            require(
                events.iter().any(|event| event["id"] == expected),
                "普通处置缺少清理凭据",
            )?;
        }
    }
    Ok(())
}

fn inventory(value: &Value, schema: EcologySchema) -> Checked {
    let mut inventory_fields = vec!["objects", "containers", "commands"];
    if schema == EcologySchema::Cycle2 && value.get("retired").is_some() {
        inventory_fields.push("retired");
    }
    exact(value, &inventory_fields)?;
    let objects = map(&value["objects"], 10_000)?;
    let containers = map(&value["containers"], 2048)?;
    let commands = map(&value["commands"], 50_000)?;
    for (key, container) in containers {
        exact(container, &["id", "kind", "capacity", "sealed"])?;
        require(
            ident(&container["id"])
                && container["id"].as_str() == Some(key)
                && member(
                    &container["kind"],
                    &[
                        "world",
                        "playerBag",
                        "cleanerPack",
                        "frogPouch",
                        "trap",
                        "corpsePile",
                        "house",
                        "disposed",
                    ],
                )
                && number(&container["capacity"])
                && container["sealed"].as_bool()
                    == Some(!member(&container["kind"], &["world", "corpsePile"])),
            "容器结构",
        )?;
    }
    for name in ["world", "playerBag", "cleanerPack", "frogPouch", "disposed"] {
        require(
            containers.get(name).is_some_and(|v| v["kind"] == name),
            "必需容器",
        )?;
    }
    for (key, item) in objects {
        let mut fields = vec![
            "id",
            "kind",
            "owner",
            "weight",
            "cleanValue",
            "hp",
            "maxHp",
            "armor",
            "pollution",
            "behavior",
            "age",
            "attackRemaining",
            "controlRemaining",
            "x",
            "y",
        ];
        if schema == EcologySchema::Cycle2 {
            fields.push("ecology");
        }
        exact(item, &fields)?;
        require(
            ident(&item["id"])
                && item["id"].as_str() == Some(key)
                && !containers.contains_key(key)
                && ident(&item["owner"])
                && containers.contains_key(item["owner"].as_str().unwrap())
                && member(
                    &item["kind"],
                    &["trash", "egg", "bug", "elite", "nest", "corpse"],
                )
                && member(
                    &item["behavior"],
                    &["forager", "breeder", "swift", "armored", "nest", "none"],
                ),
            "物品结构",
        )?;
        for field in [
            "weight",
            "cleanValue",
            "hp",
            "maxHp",
            "armor",
            "pollution",
            "age",
            "attackRemaining",
            "controlRemaining",
        ] {
            require(number(&item[field]), "物品数值")?;
        }
        require(
            item["weight"].as_f64().unwrap() > 0.0
                && safe_integer(&item["cleanValue"]).is_some()
                && item["hp"].as_f64().unwrap() <= item["maxHp"].as_f64().unwrap(),
            "物品范围",
        )?;
        point(item, true)?;
        if schema == EcologySchema::Cycle2 {
            entity_ecology(item, objects)?;
        }
    }
    for (key, receipt) in commands {
        exact(receipt, &["signature", "ok", "reason"])?;
        require(
            ident(&Value::String(key.clone()))
                && receipt["signature"]
                    .as_str()
                    .is_some_and(|s| s.encode_utf16().count() <= 16_384)
                && ident(&receipt["reason"])
                && receipt["ok"].as_bool() == Some(receipt["reason"] == "ok"),
            "命令凭据",
        )?;
    }
    if schema == EcologySchema::Cycle2 && value.get("retired").is_some() {
        let retired = &value["retired"];
        exact(retired, &["ecologyThrough", "commandTick", "homeVisits"])?;
        require(
            safe_integer(&retired["ecologyThrough"]).is_some()
                && safe_integer(&retired["commandTick"]).is_some(),
            "退役历史截止点",
        )?;
        for (house_id, visits) in map(&retired["homeVisits"], 2)? {
            require(
                ident(&Value::String(house_id.clone())) && safe_integer(visits).is_some(),
                "退役房屋访问",
            )?;
        }
    }
    Ok(())
}

fn retired(run: &Value) -> Checked {
    let retired = &run["inventory"]["retired"];
    if retired.is_null() {
        return Ok(());
    }
    let ecology_through =
        safe_integer(&retired["ecologyThrough"]).ok_or_else(|| invalid("退役生态截止点"))?;
    let command_tick =
        safe_integer(&retired["commandTick"]).ok_or_else(|| invalid("退役命令截止点"))?;
    require(
        ecology_through < safe_integer(&run["ecology"]["nextId"]).unwrap()
            && command_tick <= safe_integer(&run["tick"]).unwrap(),
        "退役历史截止关系",
    )?;
    let houses: HashSet<&str> = run["houses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|house| house["id"].as_str().unwrap())
        .collect();
    for house_id in retired["homeVisits"].as_object().unwrap().keys() {
        require(houses.contains(house_id.as_str()), "退役房屋访问身份")?;
    }
    Ok(())
}

fn economy(value: &Value, schema: EcologySchema) -> Checked {
    let mut economy_fields = vec!["parts", "events", "purchases"];
    if schema == EcologySchema::Cycle2 && value.get("archived").is_some() {
        economy_fields.push("archived");
    }
    exact(value, &economy_fields)?;
    require(safe_integer(&value["parts"]).is_some(), "零件余额")?;
    let mut ids = HashSet::new();
    for event in array(&value["events"], 20_004)? {
        exact(
            event,
            &[
                "id", "kind", "targetId", "parts", "weight", "enemy", "stage",
            ],
        )?;
        require(
            meaningful(&event["id"])
                && ids.insert(event["id"].as_str().unwrap())
                && meaningful(&event["targetId"])
                && member(&event["kind"], &["kill", "clean", "milestone"])
                && safe_integer(&event["parts"]).is_some()
                && number(&event["weight"])
                && safe_integer(&event["stage"]).is_some()
                && (event["enemy"].is_null()
                    || member(&event["enemy"], &["normal", "elite", "nest"])),
            "经济事件",
        )?;
    }
    for (key, value) in map(&value["purchases"], 50_000)? {
        require(
            !key.is_empty() && safe_integer(value).is_some(),
            "购买凭据类型",
        )?;
    }
    if schema == EcologySchema::Cycle2 && value.get("archived").is_some() {
        let archived = &value["archived"];
        exact(
            archived,
            &[
                "earnedParts",
                "cleanWeight",
                "normalKills",
                "eliteKills",
                "nestKills",
            ],
        )?;
        for field in ["earnedParts", "normalKills", "eliteKills", "nestKills"] {
            require(safe_integer(&archived[field]).is_some(), "归档经济整数")?;
        }
        let earned_parts = safe_integer(&archived["earnedParts"]).unwrap();
        let kill_income = safe_integer(&archived["normalKills"])
            .and_then(|normal| {
                safe_integer(&archived["eliteKills"])
                    .and_then(|elite| elite.checked_mul(8))
                    .and_then(|elite| normal.checked_add(elite))
            })
            .and_then(|subtotal| {
                safe_integer(&archived["nestKills"])
                    .and_then(|nests| nests.checked_mul(30))
                    .and_then(|nests| subtotal.checked_add(nests))
            });
        require(
            kill_income.is_some_and(|income| income <= SAFE_MAX_INTEGER && earned_parts >= income),
            "归档击杀收入",
        )?;
        require(
            number(&archived["cleanWeight"])
                && archived["cleanWeight"].as_f64().unwrap() <= SAFE_MAX,
            "归档清理重量",
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const EMPTY: &str =
        include_str!("../../docs/steam-v1/evidence/v4-native-storage/ts-empty.json");
    const ACTIVE: &str =
        include_str!("../../docs/steam-v1/evidence/v4-native-storage/ts-active.json");
    const HOMES: &str =
        include_str!("../../docs/steam-v1/evidence/v4-native-storage/ts-homes.json");
    const STEAM: &str =
        include_str!("../../docs/steam-v1/evidence/v4-native-storage/ts-steam.json");
    fn fixture(raw: &str) -> Value {
        serde_json::from_str::<Value>(raw).unwrap()["campaign"].clone()
    }
    fn object(kind: &str, stage: &str, sex: &str) -> Value {
        json!({
            "id":"object", "kind":kind, "owner":"world", "weight":1, "cleanValue":1,
            "hp":if matches!(kind, "bug" | "elite" | "nest") { 1 } else { 0 },
            "maxHp":if matches!(kind, "bug" | "elite" | "nest") { 1 } else { 0 },
            "armor":0, "pollution":0, "behavior":if kind == "nest" { "nest" } else { "none" },
            "age":0, "attackRemaining":0, "controlRemaining":0, "x":0.25, "y":0.75,
            "ecology":{
                "stage":stage, "sex":sex, "energy":if kind == "corpse" { 0 } else { 100 },
                "growthSeconds":0, "breedCooldown":0, "mated":false,
                "food":if kind == "trash" { 100 } else if kind == "corpse" { 20 } else { 0 },
                "carrierId":null, "wanderX":0.2, "wanderY":0.8, "wanderRemaining":0,
                "wanderSeed":4_294_967_295_u64, "heading":-1.25, "disposition":"none"
            }
        })
    }
    #[test]
    fn actual_typescript_empty_active_homes_and_steam_campaigns_pass() {
        for raw in [EMPTY, ACTIVE, HOMES, STEAM] {
            let campaign = fixture(raw);
            validate_campaign(campaign["profile"].as_str().unwrap(), &campaign).unwrap();
        }
    }
    #[test]
    fn previous_cycle_is_explicit_and_malformed_cycle2_never_falls_back() {
        let mut legacy = fixture(ACTIVE);
        legacy["activeRun"]["ecology"]
            .as_object_mut()
            .unwrap()
            .remove("cycleVersion");
        legacy["activeRun"]["ecology"]
            .as_object_mut()
            .unwrap()
            .remove("openingSpawned");
        legacy["activeRun"]["inventory"]["objects"]["object"] = object("trash", "none", "none");
        legacy["activeRun"]["inventory"]["objects"]["object"]
            .as_object_mut()
            .unwrap()
            .remove("ecology");
        validate_campaign_previous("local", &legacy).unwrap();
        assert!(validate_campaign("local", &legacy).is_err());

        legacy["activeRun"]["ecology"]["cycleVersion"] = json!(2);
        legacy["activeRun"]["ecology"]["openingSpawned"] = json!(true);
        assert!(validate_campaign_previous("local", &legacy).is_err());
        legacy["activeRun"]["ecology"]["cycleVersion"] = json!(1);
        assert!(validate_campaign_previous("local", &legacy).is_err());
    }
    #[test]
    fn cycle2_entity_fields_ranges_and_kind_stage_sex_are_strict() {
        for (kind, stage, sex) in [
            ("trash", "none", "none"),
            ("egg", "egg", "female"),
            ("bug", "small", "male"),
            ("elite", "adult", "female"),
            ("corpse", "none", "none"),
            ("corpse", "medium", "male"),
            ("nest", "none", "none"),
        ] {
            let mut campaign = fixture(ACTIVE);
            campaign["activeRun"]["inventory"]["objects"]["object"] = object(kind, stage, sex);
            validate_campaign("local", &campaign).unwrap();
        }
        let good = {
            let mut campaign = fixture(ACTIVE);
            campaign["activeRun"]["inventory"]["objects"]["object"] =
                object("bug", "adult", "female");
            campaign
        };
        for (path, replacement) in [
            (
                "/activeRun/inventory/objects/object/ecology/energy",
                json!(-1),
            ),
            (
                "/activeRun/inventory/objects/object/ecology/energy",
                json!(101),
            ),
            (
                "/activeRun/inventory/objects/object/ecology/growthSeconds",
                json!(-0.1),
            ),
            (
                "/activeRun/inventory/objects/object/ecology/wanderX",
                json!(1.1),
            ),
            (
                "/activeRun/inventory/objects/object/ecology/wanderY",
                json!(-0.1),
            ),
            (
                "/activeRun/inventory/objects/object/ecology/wanderSeed",
                json!(4_294_967_296_u64),
            ),
            (
                "/activeRun/inventory/objects/object/ecology/heading",
                json!("-1"),
            ),
            (
                "/activeRun/inventory/objects/object/ecology/stage",
                json!("egg"),
            ),
            (
                "/activeRun/inventory/objects/object/ecology/sex",
                json!("none"),
            ),
            (
                "/activeRun/inventory/objects/object/ecology/carrierId",
                json!("missing"),
            ),
            (
                "/activeRun/inventory/objects/object/ecology/disposition",
                json!("future"),
            ),
        ] {
            let mut campaign = good.clone();
            *campaign.pointer_mut(path).unwrap() = replacement;
            assert!(validate_campaign("local", &campaign).is_err(), "{path}");
        }
        validate_campaign("local", &good).unwrap();
    }
    #[test]
    fn ecology_actions_are_optional_complete_bounded_and_compaction_safe() {
        let mut feeding = fixture(ACTIVE);
        feeding["activeRun"]["inventory"]["objects"]["food"] = object("trash", "none", "none");
        feeding["activeRun"]["inventory"]["objects"]["food"]["id"] = json!("food");
        feeding["activeRun"]["inventory"]["objects"]["actor"] = object("bug", "adult", "female");
        feeding["activeRun"]["inventory"]["objects"]["actor"]["id"] = json!("actor");
        feeding["activeRun"]["inventory"]["objects"]["actor"]["ecology"]["action"] =
            json!("feeding");
        feeding["activeRun"]["inventory"]["objects"]["actor"]["ecology"]["actionElapsed"] =
            json!(f64::MAX);
        feeding["activeRun"]["inventory"]["objects"]["actor"]["ecology"]["actionTargetId"] =
            json!("food");
        validate_campaign("local", &feeding).unwrap();
        let mut compacted_feeding = feeding.clone();
        compacted_feeding["activeRun"]["inventory"]["objects"]
            .as_object_mut()
            .unwrap()
            .remove("food");
        validate_campaign("local", &compacted_feeding).unwrap();

        let mut mating = feeding.clone();
        mating["activeRun"]["inventory"]["objects"]["partner"] = object("bug", "adult", "male");
        mating["activeRun"]["inventory"]["objects"]["partner"]["id"] = json!("partner");
        mating["activeRun"]["inventory"]["objects"]["actor"]["ecology"]["action"] = json!("mating");
        mating["activeRun"]["inventory"]["objects"]["actor"]["ecology"]["actionElapsed"] = json!(4);
        mating["activeRun"]["inventory"]["objects"]["actor"]["ecology"]["actionTargetId"] =
            json!("partner");
        validate_campaign("local", &mating).unwrap();
        mating["activeRun"]["inventory"]["objects"]["partner"]["kind"] = json!("corpse");
        mating["activeRun"]["inventory"]["objects"]["partner"]["hp"] = json!(0);
        mating["activeRun"]["inventory"]["objects"]["partner"]["ecology"]["energy"] = json!(0);
        validate_campaign("local", &mating).unwrap();
        mating["activeRun"]["inventory"]["objects"]
            .as_object_mut()
            .unwrap()
            .remove("partner");
        validate_campaign("local", &mating).unwrap();

        let mut laying = feeding.clone();
        laying["activeRun"]["inventory"]["objects"]["actor"]["ecology"]["action"] = json!("laying");
        laying["activeRun"]["inventory"]["objects"]["actor"]["ecology"]["actionElapsed"] = json!(3);
        laying["activeRun"]["inventory"]["objects"]["actor"]["ecology"]["actionTargetId"] =
            json!("nursery:0.25:0.75");
        laying["activeRun"]["inventory"]["objects"]["actor"]["ecology"]["mated"] = json!(true);
        validate_campaign("local", &laying).unwrap();
        laying["activeRun"]["inventory"]["objects"]["actor"]["ecology"]["actionTargetId"] =
            Value::Null;
        validate_campaign("local", &laying).unwrap();

        for (path, replacement) in [
            (
                "/activeRun/inventory/objects/actor/ecology/action",
                json!("future"),
            ),
            (
                "/activeRun/inventory/objects/actor/ecology/actionElapsed",
                json!(-1),
            ),
            (
                "/activeRun/inventory/objects/actor/ecology/actionTargetId",
                Value::Null,
            ),
            (
                "/activeRun/inventory/objects/actor/ecology/actionTargetId",
                json!("actor"),
            ),
        ] {
            let mut bad = feeding.clone();
            *bad.pointer_mut(path).unwrap() = replacement;
            assert!(validate_campaign("local", &bad).is_err(), "{path}");
        }
        let mut missing_elapsed = feeding.clone();
        missing_elapsed["activeRun"]["inventory"]["objects"]["actor"]["ecology"]
            .as_object_mut()
            .unwrap()
            .remove("actionElapsed");
        assert!(validate_campaign("local", &missing_elapsed).is_err());

        for (action, elapsed, stage, sex, mated) in [
            ("mating", 4.01, "adult", "female", false),
            ("mating", 1.0, "medium", "female", false),
            ("laying", 3.01, "adult", "female", true),
            ("laying", 1.0, "adult", "male", true),
            ("laying", 1.0, "adult", "female", false),
        ] {
            let mut bad = feeding.clone();
            let ecology = &mut bad["activeRun"]["inventory"]["objects"]["actor"]["ecology"];
            ecology["action"] = json!(action);
            ecology["actionElapsed"] = json!(elapsed);
            ecology["actionTargetId"] = if action == "mating" {
                json!("food")
            } else {
                Value::Null
            };
            ecology["stage"] = json!(stage);
            ecology["sex"] = json!(sex);
            ecology["mated"] = json!(mated);
            assert!(
                validate_campaign("local", &bad).is_err(),
                "{action}/{elapsed}"
            );
        }

        let mut stray = fixture(ACTIVE);
        stray["activeRun"]["inventory"]["objects"]["object"] = object("bug", "adult", "female");
        stray["activeRun"]["inventory"]["objects"]["object"]["ecology"]["actionElapsed"] = json!(0);
        assert!(validate_campaign("local", &stray).is_err());
    }
    #[test]
    fn carried_egg_must_reference_world_trash() {
        let mut campaign = fixture(ACTIVE);
        campaign["activeRun"]["inventory"]["objects"]["carrier"] = object("trash", "none", "none");
        campaign["activeRun"]["inventory"]["objects"]["carrier"]["id"] = json!("carrier");
        campaign["activeRun"]["inventory"]["objects"]["egg"] = object("egg", "egg", "male");
        campaign["activeRun"]["inventory"]["objects"]["egg"]["id"] = json!("egg");
        campaign["activeRun"]["inventory"]["objects"]["egg"]["ecology"]["carrierId"] =
            json!("carrier");
        validate_campaign("local", &campaign).unwrap();
        campaign["activeRun"]["inventory"]["objects"]["carrier"]["owner"] = json!("disposed");
        assert!(validate_campaign("local", &campaign).is_err());
    }
    #[test]
    fn system_disposition_has_an_exact_non_rewarding_shape() {
        for (kind, stage, sex, disposition) in [
            ("trash", "none", "none", "consumed"),
            ("corpse", "adult", "female", "consumed"),
            ("egg", "egg", "male", "carrier-cleared"),
        ] {
            let mut campaign = fixture(ACTIVE);
            let mut item = object(kind, stage, sex);
            item["owner"] = json!("disposed");
            item["ecology"]["energy"] = json!(0);
            item["ecology"]["food"] = json!(0);
            item["ecology"]["disposition"] = json!(disposition);
            campaign["activeRun"]["inventory"]["objects"]["object"] = item;
            validate_campaign("local", &campaign).unwrap();

            let mut rewarded = campaign.clone();
            rewarded["activeRun"]["economy"]["events"] = json!([{
                "id":"clean:object", "kind":"clean", "targetId":"object", "parts":1,
                "weight":1, "enemy":null, "stage":1
            }]);
            assert!(validate_campaign("local", &rewarded).is_err());
        }
        let mut invalid = fixture(ACTIVE);
        let mut item = object("bug", "adult", "female");
        item["owner"] = json!("disposed");
        item["ecology"]["energy"] = json!(0);
        item["ecology"]["food"] = json!(0);
        item["ecology"]["disposition"] = json!("consumed");
        invalid["activeRun"]["inventory"]["objects"]["object"] = item;
        assert!(validate_campaign("local", &invalid).is_err());

        let mut ordinary = fixture(ACTIVE);
        let mut item = object("trash", "none", "none");
        item["owner"] = json!("disposed");
        ordinary["activeRun"]["inventory"]["objects"]["object"] = item;
        assert!(validate_campaign("local", &ordinary).is_err());
        ordinary["activeRun"]["economy"]["events"] = json!([{
            "id":"clean:object", "kind":"clean", "targetId":"object", "parts":1,
            "weight":1, "enemy":null, "stage":1
        }]);
        validate_campaign("local", &ordinary).unwrap();
    }
    #[test]
    fn archived_economy_and_retired_cutoffs_are_cycle2_only_and_cross_checked() {
        let mut good = fixture(ACTIVE);
        good["activeRun"]["economy"]["archived"] = json!({
            "earnedParts":0, "cleanWeight":0.5, "normalKills":0, "eliteKills":0, "nestKills":0
        });
        good["activeRun"]["inventory"]["retired"] = json!({
            "ecologyThrough":0, "commandTick":0, "homeVisits":{"home.cleaner":2}
        });
        validate_campaign("local", &good).unwrap();
        for (path, replacement) in [
            ("/activeRun/economy/archived/earnedParts", json!(-1)),
            ("/activeRun/economy/archived/normalKills", json!(0.5)),
            ("/activeRun/economy/archived/cleanWeight", json!(-0.1)),
            (
                "/activeRun/economy/archived/cleanWeight",
                json!(9_007_199_254_740_992_u64),
            ),
            ("/activeRun/inventory/retired/ecologyThrough", json!(1)),
            ("/activeRun/inventory/retired/commandTick", json!(1)),
            (
                "/activeRun/inventory/retired/homeVisits/home.cleaner",
                json!(-1),
            ),
        ] {
            let mut bad = good.clone();
            *bad.pointer_mut(path).unwrap() = replacement;
            assert!(validate_campaign("local", &bad).is_err(), "{path}");
        }
        for path in [
            "/activeRun/economy/archived",
            "/activeRun/inventory/retired",
        ] {
            let mut bad = good.clone();
            bad.pointer_mut(path).unwrap()["extra"] = json!(0);
            assert!(validate_campaign("local", &bad).is_err(), "{path}");
        }
        let mut bad_house = good.clone();
        bad_house["activeRun"]["inventory"]["retired"]["homeVisits"] = json!({"unknown":0});
        assert!(validate_campaign("local", &bad_house).is_err());

        let mut impossible_kills = good.clone();
        impossible_kills["activeRun"]["economy"]["archived"]["normalKills"] = json!(1);
        assert!(validate_campaign("local", &impossible_kills).is_err());
        let mut overflowing_kills = good.clone();
        overflowing_kills["activeRun"]["economy"]["archived"]["earnedParts"] =
            json!(9_007_199_254_740_991_u64);
        overflowing_kills["activeRun"]["economy"]["archived"]["eliteKills"] =
            json!(9_007_199_254_740_991_u64);
        assert!(validate_campaign("local", &overflowing_kills).is_err());

        let mut legacy = good;
        legacy["activeRun"]["ecology"]
            .as_object_mut()
            .unwrap()
            .remove("cycleVersion");
        legacy["activeRun"]["ecology"]
            .as_object_mut()
            .unwrap()
            .remove("openingSpawned");
        assert!(validate_campaign_previous("local", &legacy).is_err());
    }
    #[test]
    fn malformed_meta_and_research_are_rejected() {
        for (path, replacement) in [
            ("/meta", json!({})),
            ("/meta/researchPoints", json!(-1)),
            ("/meta/researchPoints", json!(9_007_199_254_740_992_u64)),
            ("/meta/appearanceId", json!("  ")),
            ("/meta/firstAttemptGranted", json!(0)),
            ("/meta/frogUnlocked", json!("false")),
            ("/meta/nodes", json!(["frog-2"])),
            ("/meta/nodes", json!(["frog-1", "frog-1"])),
            ("/meta/nodes", json!(["frog-5"])),
            ("/meta/nodes", json!(["frog-01"])),
            ("/meta/completedMissions", json!(["a", "a"])),
            ("/meta/settledRunIds", json!([" "])),
        ] {
            let mut campaign = fixture(EMPTY);
            *campaign.pointer_mut(path).unwrap() = replacement;
            assert!(validate_campaign("local", &campaign).is_err(), "{path}");
        }
        let mut campaign = fixture(EMPTY);
        campaign["meta"]["nodes"] = json!(["frog-1", "frog-2", "home-1"]);
        validate_campaign("local", &campaign).unwrap();
        campaign["meta"]["settledRunIds"] =
            Value::Array((0..10_001).map(|n| json!(format!("run-{n}"))).collect());
        assert!(validate_campaign("local", &campaign).is_err());
    }
    #[test]
    fn required_run_structures_types_and_references_are_checked() {
        for (path, replacement) in [
            ("/activeRun", json!({})),
            ("/activeRun/tick", json!(1.5)),
            ("/activeRun/phase", json!("future")),
            ("/activeRun/pauseReasons", json!(["user", "user"])),
            ("/activeRun/researchNodes", json!(["frog-1"])),
            ("/activeRun/inventory", json!({})),
            ("/activeRun/economy", json!({})),
            ("/activeRun/ecology", json!({})),
            ("/activeRun/upgrades", json!({"levels":{"unknown":1}})),
            ("/activeRun/houses", json!([])),
            ("/activeRun/actors", json!([])),
            ("/activeRun/actors/0/pose", json!({})),
            ("/activeRun/actors/0/houseId", json!("unknown")),
            ("/activeRun/actors/0/pose/activity", json!("future")),
            ("/activeRun/actors/0/atHome", json!(0)),
            ("/activeRun/houses/0/hp", json!(-1)),
            ("/activeRun/swatter", json!({})),
            ("/activeRun/traps", json!([{}])),
        ] {
            let mut campaign = fixture(ACTIVE);
            *campaign.pointer_mut(path).unwrap() = replacement;
            assert!(validate_campaign("local", &campaign).is_err(), "{path}");
        }
    }
    #[test]
    fn structural_objects_reject_missing_and_extra_fields() {
        let original = fixture(ACTIVE);
        for path in [
            "",
            "/meta",
            "/activeRun",
            "/activeRun/inventory",
            "/activeRun/economy",
            "/activeRun/ecology",
            "/activeRun/upgrades",
            "/activeRun/actors/0",
            "/activeRun/actors/0/pose",
            "/activeRun/houses/0",
            "/activeRun/swatter",
        ] {
            for key in original.pointer(path).unwrap().as_object().unwrap().keys() {
                let mut campaign = original.clone();
                campaign
                    .pointer_mut(path)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .remove(key);
                assert!(
                    validate_campaign("local", &campaign).is_err(),
                    "missing {path}/{key}"
                );
            }
            let mut campaign = original.clone();
            campaign.pointer_mut(path).unwrap()["extra"] = json!(1);
            assert!(
                validate_campaign("local", &campaign).is_err(),
                "extra {path}"
            );
        }
    }
    #[test]
    fn settlements_and_legacy_require_complete_consistent_structure() {
        let mut campaign = fixture(EMPTY);
        for bad in [
            json!({}),
            json!({"saveVersion":4,"source":{"saveVersion":4}}),
            json!({"saveVersion":3,"source":{"saveVersion":2}}),
            json!({"saveVersion":3,"source":null}),
        ] {
            campaign["legacyCompanion"] = bad;
            assert!(validate_campaign("local", &campaign).is_err());
        }
        campaign["legacyCompanion"] = json!({"saveVersion":3,"source":{"saveVersion":3}});
        validate_campaign("local", &campaign).unwrap();
        campaign["recentSettlement"] = json!({});
        assert!(validate_campaign("local", &campaign).is_err());
        campaign["recentSettlement"] = json!({"runId":"done","missionId":"demo-1","outcome":"defeat","researchReward":4,"score":40,
            "breakdown":{"base":1,"milestones":0,"firstVictory":0,"firstAttempt":3}});
        assert!(validate_campaign("local", &campaign).is_err());
        campaign["meta"]["settledRunIds"] = json!(["done"]);
        campaign["meta"]["firstAttemptGranted"] = json!(true);
        validate_campaign("local", &campaign).unwrap();
        campaign["recentSettlement"]["researchReward"] = json!(5);
        assert!(validate_campaign("local", &campaign).is_err());
    }
}
