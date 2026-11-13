//! Narrow, machine-aware transport for the Pi orchestration extension.
//! Never return raw core labels: other integrations store private routing data there.
use crate::hc::Core;
use serde_json::{json, Value};

pub fn placement(model: &crate::model::Model, address: &str) -> Option<Value> {
    model.spaces.iter().find_map(|space| space.tabs.iter().find_map(|tab| {
        tab.root.terminals().iter().any(|pane| pane.terminal() == Some(address)).then(|| json!({
            "space":space.id,"tab":tab.id,"name":crate::model::Model::tab_name(space, tab),"dedicated":tab.root.panes().len() == 1,
        }))
    }))
}

pub fn require_dedicated(placement: Option<&Value>) -> Result<(), String> {
    if placement.is_none_or(|p| p["dedicated"] != true) {
        Err("Remove only an agent in its own single-pane tab; split tabs and unrelated panes are preserved.".into())
    } else {
        Ok(())
    }
}

pub fn pi_label(record: &Value) -> Option<Value> {
    let label: Value = serde_json::from_str(record["labels"]["herdr.pi"].as_str()?).ok()?;
    (label["version"] == 1
        && label["pid"].as_u64().is_some()
        && label["session"].as_str().is_some_and(|s| !s.is_empty()))
    .then_some(label)
}

fn report(record: &Value) -> &Value {
    if record["status"].is_object() {
        &record["status"]
    } else {
        &record["report"]
    }
}

pub fn current_pi(record: &Value) -> bool {
    record["state"] == "live"
        && pi_label(record).is_some_and(|label| label["pid"] == record["foreground"]["pid"])
}

pub fn is_pi(record: &Value) -> bool {
    current_pi(record) || report(record)["app"] == "pi"
}

pub fn summary(address: &str, record: &Value, placement: Option<&Value>) -> Value {
    let current = current_pi(record);
    let label = pi_label(record);
    let state = record["status"]
        .as_str()
        .or_else(|| report(record)["state"].as_str());
    let foreground = &record["foreground"];
    let exited = record["state"] != "live"
        || (state.is_none()
            && foreground["pid"].is_number()
            && foreground["pid"] == record["pid"]
            && foreground["argv"]
                .as_array()
                .is_some_and(|args| !args.iter().any(|a| a == "-c")));
    // Keep proof of a successful startup after shell recovery. Clearing that
    // boundary could incorrectly relaunch a completed task on its fallback.
    let startup = label.as_ref().filter(|_| current || exited);
    let mut value = json!({
        "terminal": address, "machine": address.split_once('/').map(|(m, _)| m),
        "state": record["state"], "status": state,
        "message": report(record)["msg"], "pid": foreground["pid"],
        "session": label.as_ref().filter(|_| current).map(|p| &p["session"]),
        "startup": startup.map(|p| &p["startup"]),
        "error": startup.map(|p| &p["error"]), "exited": exited, "identityCurrent": current,
        "name": record["name"],
    });
    if let Some(placement) = placement {
        for key in ["space", "tab", "name"] {
            value[key] = placement[key].clone();
        }
    }
    value
}

fn exact_address(address: &str) -> bool {
    let id = address.split_once('/').map_or(
        address,
        |(machine, id)| if machine.is_empty() { "" } else { id },
    );
    id.strip_prefix('t')
        .is_some_and(|tail| !tail.is_empty() && tail.chars().all(|c| c.is_ascii_alphanumeric()))
}
pub fn validate_identity(record: &Value, args: &Value) -> Result<(), String> {
    if !current_pi(record) {
        return Err("No current Pi identity in this terminal. Inspect it before acting.".into());
    }
    let label = pi_label(record).expect("checked current Pi");
    if args["pid"].as_u64().is_none()
        || args["pid"] != label["pid"]
        || args["session"].as_str().is_none()
        || args["session"] != label["session"]
    {
        return Err(
            "The agent PID or session changed. Inspect it and use the current identity.".into(),
        );
    }
    Ok(())
}

/// Runs on a worker. Re-read immediately before a mutation rather than trusting
/// the window's event cache, which may describe a previous process in the pane.
pub fn request(
    core: &Core,
    action: &str,
    args: &Value,
    placement: Option<&Value>,
) -> Result<Value, String> {
    let address = args["terminal"]
        .as_str()
        .filter(|s| exact_address(s))
        .ok_or("Use an exact terminal id such as t7 or machine/t7, not a display name")?;
    let record = core
        .call("terminal.get", json!({"terminal":address}))
        .map_err(|e| format!("Cannot inspect {address}: {e:#}"))?;
    let id = address.rsplit('/').next().unwrap_or(address);
    if record["address"]
        .as_str()
        .is_none_or(|actual| actual != address && actual != id)
    {
        return Err("The selector resolved through a display name. Use the stable terminal id from agent.list.".into());
    }
    if action == "agent.inspect" {
        let lines = args
            .get("lines")
            .map(|n| {
                n.as_u64()
                    .filter(|n| *n <= 400)
                    .ok_or("lines must be an integer from 0 through 400")
            })
            .transpose()?
            .unwrap_or(80);
        let read = core
            .call("terminal.read", json!({"terminal":address,"lines":lines}))
            .map_err(|e| format!("Cannot read {address}: {e:#}"))?;
        let mut result = summary(address, &record, placement);
        result["screen"] = read["text"].clone();
        result["screenComplete"] = read["complete"].clone();
        result["screenHow"] = read["how"].clone();
        result["screenWhy"] = read["why"].clone();
        return Ok(result);
    }
    validate_identity(&record, args)?;
    let params = match action {
        "agent.send" => {
            if report(&record)["state"] == "blocked" {
                return Err(
                    "The agent is waiting for the user. Do not bypass its question.".into(),
                );
            }
            if pi_label(&record).is_none_or(|label| label["startup"] != "started") {
                return Err(
                    "The agent is still starting. Give its first message through create, not send."
                        .into(),
                );
            }
            let text = args["message"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or("agent.send needs a non-empty message")?;
            (
                "terminal.send",
                json!({"terminal":address,"text":text,"force":false,"wait":false}),
            )
        }
        "agent.stop" => (
            "terminal.interrupt",
            json!({"terminal":address,"timeout":10}),
        ),
        "agent.remove" => ("terminal.kill", json!({"terminal":address})),
        _ => return Err(format!("Unknown agent action {action}")),
    };
    let observed = core
        .call_timeout(params.0, params.1, std::time::Duration::from_secs(20))
        .map_err(|e| format!("{action}: {e:#}"))?;
    let mut result =
        json!({"terminal":address,"pid":args["pid"],"session":args["session"],"action":action});
    match action {
        "agent.send" => {
            for key in ["started", "status", "turn"] {
                result[key] = observed[key].clone();
            }
        }
        "agent.stop" => {
            for key in ["outcome", "key"] {
                result[key] = observed[key].clone();
            }
        }
        "agent.remove" => {
            if observed["state"] == "live" {
                return Err("The terminal is still live; its tab was retained.".into());
            }
            result["outcome"] = json!("removed");
        }
        _ => unreachable!(),
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> Value {
        json!({"address":"remote/t1","state":"live","pid":1,"foreground":{"pid":7,"argv":["pi"]},"status":{"state":"working","app":"pi","msg":"Task"},"labels":{"herdr.pi":json!({"version":1,"pid":7,"session":"s1","startup":"started"}).to_string(),"private":"secret"}})
    }
    #[test]
    fn removal_requires_a_dedicated_tab_and_preserves_split_panes() {
        let mut model = crate::model::Model::default();
        model.add_space(
            "sp1",
            "Tasks",
            "/repo",
            crate::model::Tab::new("tb1", "Task", "p1", "t1"),
        );
        assert!(require_dedicated(placement(&model, "t1").as_ref()).is_ok());
        model.split("p1", crate::layout::Axis::Row, "p2", "t2");
        assert!(require_dedicated(placement(&model, "t1").as_ref()).is_err());
        assert!(require_dedicated(placement(&model, "missing").as_ref()).is_err());
        assert_eq!(model.tab("tb1").unwrap().root.panes().len(), 2);
    }

    #[test]
    fn display_names_cannot_select_an_unintended_agent() {
        for address in ["t7", "remote/t1a", "laptop-wsl/t16h"] {
            assert!(exact_address(address));
        }
        for address in [
            "Task",
            "",
            "/t7",
            "remote/Task",
            "remote/nested/t7",
            "t7 name",
        ] {
            assert!(!exact_address(address));
        }
    }

    #[test]
    fn identity_rejects_stale_nested_and_replaced_processes() {
        let mut r = record();
        let args = json!({"pid":7,"session":"s1"});
        assert!(validate_identity(&r, &args).is_ok());
        assert!(validate_identity(&r, &json!({"pid":7,"session":"other"})).is_err());
        r["foreground"]["pid"] = json!(8);
        assert!(!current_pi(&r));
        assert!(validate_identity(&r, &args).is_err());
        assert_eq!(summary("remote/t1", &r, None)["session"], Value::Null);
    }
    #[test]
    fn summaries_never_expose_routing_labels() {
        let result = summary(
            "remote/t1",
            &record(),
            Some(&json!({"space":"remote/sp1","tab":"remote/tb1","name":"Task"})),
        );
        assert_eq!(result["startup"], "started");
        assert_eq!(result["tab"], "remote/tb1");
        assert!(!result.to_string().contains("private"));
        assert!(!result.to_string().contains("secret"));
    }
    #[test]
    fn recovered_shell_does_not_claim_a_previous_pi_session() {
        let mut r = record();
        r["status"] = Value::Null;
        r["foreground"] = json!({"pid":1,"argv":["bash"]});
        assert_eq!(summary("remote/t1", &r, None)["exited"], true);
        assert_eq!(summary("remote/t1", &r, None)["startup"], "started");
        assert_eq!(summary("remote/t1", &r, None)["identityCurrent"], false);
    }
}
