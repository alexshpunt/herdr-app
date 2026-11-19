//! User-owned workflow profiles and machine-scoped Pi model catalogs.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

static WRITES: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// When to use this profile; agents read it to choose one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_model: Option<String>,
    pub thinking: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Config {
    pub version: u32,
    pub profiles: Vec<Profile>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            profiles: vec![
                Profile {
                    id: "feature".into(),
                    name: "Features".into(),
                    description: Some("New features and changes.".into()),
                    model: "anthropic/claude-opus-5-5".into(),
                    fallback_model: Some("openai-codex/gpt-6.1-sol".into()),
                    thinking: "high".into(),
                },
                Profile {
                    id: "bug".into(),
                    name: "Bugs".into(),
                    description: Some("Bug fixes.".into()),
                    model: "anthropic/claude-sonnet-5-5".into(),
                    fallback_model: Some("openai-codex/gpt-6.1-terra".into()),
                    thinking: "high".into(),
                },
            ],
        }
    }
}

/// Profile ids are lowercase kebab-case, such as `review` or `quick-fix`.
fn profile_id(id: &str) -> bool {
    !id.is_empty()
        && id.split('-').all(|part| {
            !part.is_empty() && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

fn model_id(model: &str) -> bool {
    model
        .split_once('/')
        .is_some_and(|(provider, id)| !provider.is_empty() && !id.is_empty())
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:/@+-".contains(c))
}

fn thinking(value: &str) -> bool {
    matches!(
        value,
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
    )
}

fn validate(config: &Config) -> Result<(), String> {
    if config.version != 1 {
        return Err("Unsupported workflow configuration version".into());
    }
    let mut ids = std::collections::HashSet::new();
    for profile in &config.profiles {
        if profile.id.trim().is_empty()
            || profile.name.trim().is_empty()
            || !ids.insert(&profile.id)
        {
            return Err("Workflow profiles need unique ids and non-empty names".into());
        }
        if !model_id(&profile.model)
            || profile
                .fallback_model
                .as_deref()
                .is_some_and(|m| !model_id(m))
        {
            return Err(
                "A workflow model must be a provider/model id without whitespace or shell syntax"
                    .into(),
            );
        }
        if !thinking(&profile.thinking) {
            return Err("Unknown workflow thinking level".into());
        }
    }
    Ok(())
}

fn load_at(path: &Path) -> Result<Config, String> {
    let config = match std::fs::read_to_string(path) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|e| format!("Cannot read workflow.json: {e}"))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Config::default(),
        Err(e) => return Err(format!("Cannot read workflow.json: {e}")),
    };
    validate(&config)?;
    Ok(config)
}

/// Apply the optional fields shared by workflow.set and workflow.add; `command` names the caller in errors.
fn apply(profile: &mut Profile, args: &Value, command: &str) -> Result<(), String> {
    if let Some(model) = args.get("model") {
        profile.model = model
            .as_str()
            .filter(|id| model_id(id))
            .ok_or_else(|| format!("{command} model must be provider/model"))?
            .into();
    }
    if let Some(name) = args.get("name") {
        profile.name = name
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| format!("{command} name must be a non-empty string"))?
            .into();
    }
    if let Some(description) = args.get("description") {
        profile.description = match description {
            Value::Null => None,
            Value::String(text) if text.trim().is_empty() => None,
            Value::String(text) => Some(text.trim().into()),
            _ => return Err(format!("{command} description must be a string, or null to clear it")),
        };
    }
    if let Some(fallback) = args.get("fallbackModel") {
        profile.fallback_model = match fallback {
            Value::Null => None,
            Value::String(id) if model_id(id) => Some(id.clone()),
            _ => {
                return Err(format!(
                    "{command} fallbackModel must be provider/model, or null to disable it"
                ))
            }
        };
    }
    if let Some(level) = args.get("thinking") {
        profile.thinking = level
            .as_str()
            .filter(|s| thinking(s))
            .ok_or_else(|| {
                format!("{command} thinking must be off, minimal, low, medium, high, or xhigh")
            })?
            .into();
    }
    Ok(())
}

/// Load, change and save the configuration under the write lock; nothing is written when `change` fails.
fn update_at(path: &Path, change: impl FnOnce(&mut Config) -> Result<(), String>) -> Result<Config, String> {
    let _guard = WRITES.lock().map_err(|e| e.to_string())?;
    let mut config = load_at(path)?;
    change(&mut config)?;
    validate(&config)?;
    std::fs::create_dir_all(
        path.parent()
            .ok_or("Workflow file needs a parent directory")?,
    )
    .map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())? + "\n";
    crate::persist::write_atomic(path, text)
        .map_err(|e| format!("Cannot save workflow.json: {e}"))?;
    Ok(config)
}

fn profile_arg<'a>(args: &'a Value, command: &str) -> Result<&'a str, String> {
    args["profile"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| format!("{command} needs profile"))
}

fn set_at(path: &Path, args: &Value) -> Result<Config, String> {
    let id = profile_arg(args, "workflow.set")?;
    update_at(path, |config| {
        let profile = config
            .profiles
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("No workflow profile {id:?}"))?;
        apply(profile, args, "workflow.set")
    })
}

fn add_at(path: &Path, args: &Value) -> Result<Config, String> {
    let id = args["id"]
        .as_str()
        .filter(|id| profile_id(id))
        .ok_or("workflow.add id must be lowercase kebab-case, such as review or quick-fix")?;
    if !args["name"].is_string() { return Err("workflow.add needs name".into()); }
    if !args["model"].is_string() { return Err("workflow.add needs model".into()); }
    update_at(path, |config| {
        if config.profiles.iter().any(|p| p.id == id) {
            return Err(format!("Workflow profile {id:?} already exists"));
        }
        let mut profile = Profile {
            id: id.into(),
            name: String::new(),
            description: None,
            model: String::new(),
            fallback_model: None,
            thinking: "high".into(),
        };
        apply(&mut profile, args, "workflow.add")?;
        config.profiles.push(profile);
        Ok(())
    })
}

fn remove_at(path: &Path, args: &Value) -> Result<Config, String> {
    let id = profile_arg(args, "workflow.remove")?;
    update_at(path, |config| {
        let before = config.profiles.len();
        config.profiles.retain(|p| p.id != id);
        if config.profiles.len() == before { return Err(format!("No workflow profile {id:?}")); }
        Ok(())
    })
}

pub fn get() -> Result<Value, String> {
    serde_json::to_value(load_at(&crate::mods::app_dir().join("workflow.json"))?)
        .map_err(|e| e.to_string())
}

pub fn set(args: &Value) -> Result<Value, String> {
    serde_json::to_value(set_at(&crate::mods::app_dir().join("workflow.json"), args)?)
        .map_err(|e| e.to_string())
}

pub fn add(args: &Value) -> Result<Value, String> {
    serde_json::to_value(add_at(&crate::mods::app_dir().join("workflow.json"), args)?)
        .map_err(|e| e.to_string())
}

pub fn remove(args: &Value) -> Result<Value, String> {
    serde_json::to_value(remove_at(&crate::mods::app_dir().join("workflow.json"), args)?)
        .map_err(|e| e.to_string())
}

#[derive(Default)]
struct Catalog {
    value: Option<Value>,
    at: Option<Instant>,
    refreshing: bool,
}
static CATALOGS: OnceLock<Mutex<BTreeMap<Option<String>, Catalog>>> = OnceLock::new();

/// Return a cached snapshot immediately; remote execution never blocks the UI.
pub fn models<'a>(core: Arc<crate::hc::Core>, records: impl IntoIterator<Item = &'a Value>, machine: Option<&str>) -> Value {
    let key = machine.map(str::to_owned);
    let cache = CATALOGS.get_or_init(Mutex::default);
    let mut entries = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let entry = entries.entry(key.clone()).or_default();
    let refresh = !entry.refreshing && entry.at.is_none_or(|at| at.elapsed() >= Duration::from_secs(30));
    let snapshot = entry.value.clone().unwrap_or_else(|| json!({"models":[], "source":"pi-settings"}));
    let loading = entry.value.is_none();
    if refresh { entry.refreshing = true; }
    drop(entries);
    if refresh {
        let failed_key = key.clone();
        if let Err(error) = std::thread::Builder::new().name("pi-model-catalog".into()).spawn(move || {
            let value = crate::pi_install::model_catalog(&core, key.as_deref())
                .unwrap_or_else(|error| json!({"models":[], "source":"pi-settings", "error":error}));
            let mut entries = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let entry = entries.entry(key).or_default();
            entry.value = Some(value);
            entry.at = Some(Instant::now());
            entry.refreshing = false;
        }) {
            let mut entries = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let entry = entries.entry(failed_key).or_default();
            entry.value = Some(json!({"models":[], "error":format!("Cannot start Pi model lookup: {error}")}));
            entry.at = Some(Instant::now());
            entry.refreshing = false;
        }
    }
    let mut result = merge_catalogs(snapshot, catalog(records, machine));
    result["loading"] = json!(loading);
    result
}

fn merge_catalogs(mut settings: Value, live: Value) -> Value {
    let mut models = BTreeMap::<String, Value>::new();
    for model in settings["models"].as_array().into_iter().flatten().chain(live["models"].as_array().into_iter().flatten()) {
        if let Some(id) = model["id"].as_str().filter(|id| model_id(id)) {
            models.entry(id.to_owned()).or_insert_with(|| model.clone());
        }
    }
    settings["models"] = json!(models.into_values().collect::<Vec<_>>());
    settings["machine"] = live["machine"].clone();
    settings["sessions"] = live["sessions"].clone();
    if live["sessions"].as_u64().unwrap_or(0) > 0 { settings["source"] = json!("pi-settings+live-pi"); }
    settings
}
/// Only the terminal's root or foreground Pi may publish its picker. Old labels
/// survive shell recovery, so labels alone never prove current availability.
pub fn catalog<'a>(records: impl IntoIterator<Item = &'a Value>, machine: Option<&str>) -> Value {
    let mut models = BTreeMap::<String, String>::new();
    let mut sessions = 0;
    for record in records {
        let Some(address) = record["address"].as_str() else {
            continue;
        };
        if address.split_once('/').map(|(m, _)| m) != machine || record["state"] != "live" {
            continue;
        }
        let Some(label) = record["labels"]["herdr.pi"]
            .as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
        else {
            continue;
        };
        if !crate::agents::current_pi(record) {
            continue;
        }
        sessions += 1;
        for model in label["models"].as_array().into_iter().flatten() {
            if let Some(id) = model["id"].as_str().filter(|s| model_id(s)) {
                models
                    .entry(id.to_owned())
                    .or_insert_with(|| model["name"].as_str().unwrap_or(id).to_owned());
            }
        }
    }
    let mut result = json!({ "machine": machine, "models": models.into_iter().map(|(id, name)| json!({"id":id,"name":name})).collect::<Vec<_>>(), "source": "live-pi", "sessions": sessions });
    if sessions == 0 {
        result["error"] = json!("No current Pi model catalog on this machine. Start or reload Pi in Herdr with the orchestration extension. The catalog updates automatically.");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!(
                "herdr-workflow-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
            .join("workflow.json")
    }

    #[test]
    fn profiles_persist_independently_and_null_removes_fallback() {
        let path = scratch();
        let original = load_at(&path).unwrap();
        assert_eq!(
            original
                .profiles
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            ["feature", "bug"]
        );
        let changed = set_at(
            &path,
            &json!({"profile":"feature", "model":"provider/new-model", "fallbackModel":null}),
        )
        .unwrap();
        assert_eq!(changed.profiles[0].model, "provider/new-model");
        assert_eq!(changed.profiles[0].fallback_model, None);
        assert_eq!(changed.profiles[1], original.profiles[1]);
        assert_eq!(load_at(&path).unwrap(), changed);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn thinking_levels_persist_without_changing_either_model_or_the_other_profile() {
        let path = scratch();
        let original = load_at(&path).unwrap();
        for level in ["off", "minimal", "low", "medium", "high", "xhigh"] {
            let changed = set_at(&path, &json!({
                "profile": "feature", "model": original.profiles[0].model, "thinking": level
            })).unwrap();
            assert_eq!(changed.profiles[0].thinking, level);
            assert_eq!(changed.profiles[0].model, original.profiles[0].model);
            assert_eq!(changed.profiles[0].fallback_model, original.profiles[0].fallback_model);
            assert_eq!(changed.profiles[1], original.profiles[1]);
            assert_eq!(load_at(&path).unwrap(), changed);
        }
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn updates_preserve_fallback_when_omitted_and_reject_invalid_input_without_writing() {
        let path = scratch();
        let changed = set_at(
            &path,
            &json!({"profile":"bug", "model":"provider/model:variant"}),
        )
        .unwrap();
        assert_eq!(
            changed.profiles[1].fallback_model.as_deref(),
            Some("openai-codex/gpt-6.1-terra")
        );
        for args in [
            json!({"profile":"bug", "model":"--flag"}),
            json!({"profile":"bug", "model":"provider/model;exit"}),
            json!({"profile":"bug", "model":3}),
            json!({"profile":"missing", "model":"provider/model"}),
            json!({"profile":"bug", "model":"provider/model", "thinking":"arbitrary"}),
            json!({"profile":"bug", "model":"provider/model", "fallbackModel":false}),
        ] {
            assert!(set_at(&path, &args).is_err());
            assert_eq!(load_at(&path).unwrap(), changed);
        }
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn future_profile_rows_survive_updates_to_existing_profiles() {
        let path = scratch();
        let mut config = Config::default();
        config.profiles.push(Profile {
            id: "review".into(),
            name: "Reviews".into(),
            description: None,
            model: "provider/reviewer".into(),
            fallback_model: None,
            thinking: "high".into(),
        });
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        crate::persist::write_atomic(&path, serde_json::to_string(&config).unwrap()).unwrap();
        let changed = set_at(&path, &json!({"profile":"bug","model":"provider/fixer"})).unwrap();
        assert_eq!(changed.profiles[2], config.profiles[2]);
        assert_eq!(changed.profiles[1].model, "provider/fixer");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn profiles_are_added_with_defaults_and_removed_down_to_none() {
        let path = scratch();
        let added = add_at(&path, &json!({"id":"quick-fix", "name":" Quick fixes ", "model":"provider/fast"})).unwrap();
        let profile = added.profiles.last().unwrap();
        assert_eq!(
            (profile.id.as_str(), profile.name.as_str(), profile.model.as_str(), profile.thinking.as_str()),
            ("quick-fix", "Quick fixes", "provider/fast", "high")
        );
        assert_eq!((profile.description.as_ref(), profile.fallback_model.as_ref()), (None, None));
        let full = add_at(&path, &json!({
            "id":"review2", "name":"Reviews", "model":"provider/reviewer", "description":"Code review.",
            "fallbackModel":"provider/backup", "thinking":"xhigh"
        })).unwrap();
        let review = full.profiles.last().unwrap();
        assert_eq!(review.description.as_deref(), Some("Code review."));
        assert_eq!(review.fallback_model.as_deref(), Some("provider/backup"));
        assert_eq!(review.thinking, "xhigh");
        assert_eq!(load_at(&path).unwrap(), full);
        let removed = remove_at(&path, &json!({"profile":"feature"})).unwrap();
        assert_eq!(removed.profiles.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["bug", "quick-fix", "review2"]);
        for id in ["bug", "quick-fix", "review2"] { remove_at(&path, &json!({"profile":id})).unwrap(); }
        // The last profile can go too, and an empty table stays empty instead of returning to the defaults.
        assert!(load_at(&path).unwrap().profiles.is_empty());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn invalid_additions_and_removals_change_nothing() {
        let path = scratch();
        let saved = set_at(&path, &json!({"profile":"bug", "model":"provider/fixer"})).unwrap();
        for args in [
            json!({"id":"feature", "name":"Again", "model":"provider/model"}),
            json!({"id":"Review", "name":"Reviews", "model":"provider/model"}),
            json!({"id":"quick_fix", "name":"Reviews", "model":"provider/model"}),
            json!({"id":"-review", "name":"Reviews", "model":"provider/model"}),
            json!({"id":"review--x", "name":"Reviews", "model":"provider/model"}),
            json!({"id":"review", "name":" ", "model":"provider/model"}),
            json!({"id":"review", "model":"provider/model"}),
            json!({"id":"review", "name":"Reviews"}),
            json!({"id":"review", "name":"Reviews", "model":"no-provider"}),
            json!({"id":"review", "name":"Reviews", "model":"provider/model", "thinking":"max"}),
            json!({"id":"review", "name":"Reviews", "model":"provider/model", "description":3}),
        ] {
            assert!(add_at(&path, &args).is_err(), "{args}");
            assert_eq!(load_at(&path).unwrap(), saved, "{args}");
        }
        for args in [json!({"profile":"missing"}), json!({})] {
            assert!(remove_at(&path, &args).is_err(), "{args}");
            assert_eq!(load_at(&path).unwrap(), saved);
        }
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn set_renames_and_describes_without_a_model_and_clears_descriptions() {
        let path = scratch();
        let original = load_at(&path).unwrap();
        let changed = set_at(&path, &json!({"profile":"bug", "name":"Fixes", "description":" Small fixes. "})).unwrap();
        assert_eq!((changed.profiles[1].name.as_str(), changed.profiles[1].description.as_deref()), ("Fixes", Some("Small fixes.")));
        assert_eq!(changed.profiles[1].model, original.profiles[1].model);
        assert_eq!(changed.profiles[0], original.profiles[0]);
        for clear in [json!(""), json!(null)] {
            set_at(&path, &json!({"profile":"bug", "description":"again"})).unwrap();
            let cleared = set_at(&path, &json!({"profile":"bug", "description":clear})).unwrap();
            assert_eq!(cleared.profiles[1].description, None);
            assert!(!std::fs::read_to_string(&path).unwrap().contains("\"description\": null"));
        }
        let saved = load_at(&path).unwrap();
        for args in [json!({"profile":"bug", "name":""}), json!({"profile":"bug", "name":null}), json!({"profile":"bug", "description":false})] {
            assert!(set_at(&path, &args).is_err(), "{args}");
            assert_eq!(load_at(&path).unwrap(), saved);
        }
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn files_written_before_descriptions_keep_loading() {
        let path = scratch();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"version":1,"profiles":[{"id":"feature","name":"Features","model":"provider/a","thinking":"high"}]}"#).unwrap();
        let config = load_at(&path).unwrap();
        assert_eq!(config.profiles.len(), 1);
        assert_eq!(config.profiles[0].description, None);
        let described = set_at(&path, &json!({"profile":"feature", "description":"Features."})).unwrap();
        assert_eq!(serde_json::to_value(&described).unwrap()["profiles"][0]["description"], "Features.");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn corrupted_configuration_is_not_overwritten() {
        let path = scratch();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{invalid").unwrap();
        assert!(load_at(&path).is_err());
        assert!(set_at(
            &path,
            &json!({"profile":"feature", "model":"provider/model"})
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{invalid");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    fn terminal(address: &str, pid: u64, owner: u64, model: &str) -> Value {
        json!({"address":address,"state":"live","foreground":{"pid":pid},"labels":{"herdr.pi":json!({"version":1,"pid":owner,"session":"test-session","models":[{"id":model,"name":model}]}).to_string()}})
    }

    #[test]
    fn catalogs_are_machine_scoped_and_require_a_live_matching_pi_process() {
        let mut ended = terminal("remote/t3", 8, 8, "provider/ended");
        ended["state"] = json!("finished");
        let records = vec![
            terminal("t1", 5, 5, "provider/local"),
            terminal("remote/t1", 6, 6, "provider/remote"),
            terminal("remote/t2", 7, 99, "provider/stale"),
            ended,
        ];
        assert_eq!(
            catalog(records.iter(), None)["models"],
            json!([{"id":"provider/local","name":"provider/local"}])
        );
        assert_eq!(
            catalog(records.iter(), Some("remote"))["models"],
            json!([{"id":"provider/remote","name":"provider/remote"}])
        );
        let missing = catalog(records.iter(), Some("elsewhere"));
        assert_eq!(missing["models"], json!([]));
        assert!(missing.get("error").is_some());
    }
}
