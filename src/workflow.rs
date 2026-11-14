//! User-owned workflow profiles and live Pi model catalogs.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

static WRITES: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
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
                    model: "anthropic/claude-opus-5-5".into(),
                    fallback_model: Some("openai-codex/gpt-6.1-sol".into()),
                    thinking: "high".into(),
                },
                Profile {
                    id: "bug".into(),
                    name: "Bugs".into(),
                    model: "anthropic/claude-sonnet-5-5".into(),
                    fallback_model: Some("openai-codex/gpt-6.1-terra".into()),
                    thinking: "high".into(),
                },
            ],
        }
    }
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

fn set_at(path: &Path, args: &Value) -> Result<Config, String> {
    let _guard = WRITES.lock().map_err(|e| e.to_string())?;
    let id = args["profile"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("workflow.set needs profile")?;
    let model = args["model"]
        .as_str()
        .filter(|id| model_id(id))
        .ok_or("workflow.set model must be provider/model")?;
    let mut config = load_at(path)?;
    let profile = config
        .profiles
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("No workflow profile {id:?}"))?;
    profile.model = model.into();
    if let Some(fallback) = args.get("fallbackModel") {
        profile.fallback_model = match fallback {
            Value::Null => None,
            Value::String(id) if model_id(id) => Some(id.clone()),
            _ => {
                return Err(
                    "workflow.set fallbackModel must be provider/model, or null to disable it"
                        .into(),
                )
            }
        };
    }
    if let Some(level) = args.get("thinking") {
        profile.thinking = level
            .as_str()
            .filter(|s| thinking(s))
            .ok_or("workflow.set thinking must be off, minimal, low, medium, high, or xhigh")?
            .into();
    }
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

pub fn get() -> Result<Value, String> {
    serde_json::to_value(load_at(&crate::mods::app_dir().join("workflow.json"))?)
        .map_err(|e| e.to_string())
}

pub fn set(args: &Value) -> Result<Value, String> {
    serde_json::to_value(set_at(&crate::mods::app_dir().join("workflow.json"), args)?)
        .map_err(|e| e.to_string())
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
