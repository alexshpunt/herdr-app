//! Narrow, machine-aware transport for the Pi orchestration extension.
//! Never return raw core labels: other integrations store private routing data there.
use crate::hc::Core;
use base64::Engine as _;
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

/// Core lifecycle events can remove the tab before the kill reply reaches the
/// window. Treat that completed removal as success, but never close a replacement.
pub fn removal_tab(current: Option<&Value>, expected: Option<&Value>, expected_tab_exists: bool) -> Result<Option<String>, String> {
    if current.is_none() && !expected_tab_exists { return Ok(None); }
    if let Some(current) = current {
        if current["dedicated"] == true && expected.is_some_and(|old| old["tab"] == current["tab"]) {
            if let Some(tab) = current["tab"].as_str() { return Ok(Some(tab.into())); }
        }
    }
    Err("The agent ended, but its tab changed during removal. The tab was retained.".into())
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
    let exited = record["state"]
        .as_str()
        .is_some_and(|state| state != "live")
        || (!current
            && label.is_some()
            && state.is_none()
            && foreground["pid"].is_number()
            && foreground["pid"] == record["pid"]);
    // An unlabelled shell may still be launching Pi (-lic or -NoExit -Command).
    // Its command line alone cannot prove that the first model attempt exited.
    // Keep proof of a successful startup after shell recovery. Clearing that
    // boundary could incorrectly relaunch a completed task on its fallback.
    let startup = label.as_ref().filter(|_| current || exited);
    let mut value = json!({
        "terminal": address, "machine": address.split_once('/').map(|(m, _)| m),
        "state": record["state"], "status": state,
        "message": report(record)["msg"], "pid": foreground["pid"],
        "session": label.as_ref().filter(|_| current).map(|p| &p["session"]),
        "startup": startup.map(|p| &p["startup"]),
        "startupError": startup.map(|p| &p["error"]), "exited": exited, "identityCurrent": current,
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

fn send_params(address: &str, record: &Value, args: &Value) -> Result<Value, String> {
    let state = record["status"]
        .as_str()
        .or_else(|| report(record)["state"].as_str());
    if state == Some("blocked") {
        return Err("The agent is waiting for the user. Do not bypass its question.".into());
    }
    if pi_label(record).is_none_or(|label| label["startup"] != "started") {
        return Err(
            "The agent is still starting. Give its first message through create, not send.".into(),
        );
    }
    let text = args["message"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("agent.send needs a non-empty message")?;
    let label = pi_label(record).ok_or("The Pi identity is unavailable")?;
    let route = |field: &str| -> Result<&str, String> {
        label[field].as_str().filter(|s| !s.is_empty()).ok_or_else(|| "The Pi message integration is unavailable; reload this Pi before sending a follow-up".into())
    };
    for field in ["socket", "token"] {
        route(field)?;
    }
    let input = serde_json::to_vec(&json!({"message":text})).map_err(|error| error.to_string())?;
    if input.len() > 256 * 1024 - 1024 {
        return Err("The Pi follow-up message is too large".into());
    }
    let (machine, id) = address
        .split_once('/')
        .map_or((None, address), |(machine, id)| (Some(machine), id));
    // The helper calls the current Pi's authenticated local IPC. Native
    // terminal.send cannot guard PID/session and could type into a shell.
    Ok(
        json!({"on":machine,"argv":[route("node")?,route("request")?,id,args["pid"].to_string(),args["session"].as_str().unwrap_or_default(),route("hc")?],"input":base64::engine::general_purpose::STANDARD.encode(input),"timeout":18}),
    )
}
fn include_screen(args: &Value) -> Result<bool, String> {
    match args.get("screen") {
        None | Some(Value::Null) => Ok(true),
        Some(Value::Bool(screen)) => Ok(*screen),
        _ => Err("screen must be a boolean".into()),
    }
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
        if !include_screen(args)? {
            return Ok(summary(address, &record, placement));
        }
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
        "agent.send" => ("machine.exec", send_params(address, &record, args)?),
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
            if observed["code"].as_i64() != Some(0) || observed["timed_out"] == true {
                return Err("Pi did not confirm follow-up submission. Inspect the agent before resending; the message may already have been submitted.".into());
            }
            let output = base64::engine::general_purpose::STANDARD
                .decode(observed["stdout"].as_str().unwrap_or_default())
                .map_err(|_| {
                    "Pi returned an invalid message confirmation; inspect before resending"
                })?;
            let confirmation: Value = serde_json::from_slice(&output)
                .map_err(|_| "Pi returned no message confirmation; inspect before resending")?;
            if confirmation["outcome"] != "submitted" {
                return Err(
                    "Pi did not confirm message submission; inspect before resending".into(),
                );
            }
            result["outcome"] = json!("submitted");
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
        let expected = json!({"tab":"tb1","dedicated":true});
        assert_eq!(removal_tab(Some(&expected), Some(&expected), true).unwrap(), Some("tb1".into()));
        assert_eq!(removal_tab(None, Some(&expected), false).unwrap(), None);
        assert!(removal_tab(None, Some(&expected), true).is_err());
        assert!(removal_tab(Some(&json!({"tab":"tb2","dedicated":true})), Some(&expected), true).is_err());
        assert!(removal_tab(Some(&json!({"tab":"tb1","dedicated":false})), Some(&expected), true).is_err());
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
        assert!(include_screen(&json!({})).unwrap());
        assert!(!include_screen(&json!({"screen":false})).unwrap());
        assert!(include_screen(&json!({"screen":"false"})).is_err());
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
        let mut failed = record();
        failed["labels"]["herdr.pi"] = json!(
            json!({"version":1,"pid":7,"session":"s1","startup":"failed","error":"model quota"})
                .to_string()
        );
        let failure = summary("remote/t1", &failed, None);
        assert_eq!(failure["startupError"], "model quota");
        assert!(
            failure.get("error").is_none(),
            "top-level error is reserved for command failure"
        );
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
    fn launch_shells_are_pending_until_a_pi_identity_was_observed() {
        for argv in [
            json!(["/bin/bash", "-lic", "pi --model provider/model"]),
            json!(["pwsh", "-NoExit", "-Command", "pi --model provider/model"]),
            json!(["bash"]),
        ] {
            let r = json!({"state":"live","pid":1,"foreground":{"pid":1,"argv":argv},"status":null,"labels":{}});
            let agent = summary("t1", &r, None);
            assert_eq!(agent["exited"], false);
            assert_eq!(agent["startup"], Value::Null);
            assert_eq!(agent["identityCurrent"], false);
        }
        for r in [
            json!({}),
            json!({"state":"live","pid":1,"foreground":null,"labels":{}}),
        ] {
            assert_eq!(summary("t1", &r, None)["exited"], false);
        }
        assert_eq!(
            summary("t1", &json!({"state":"finished"}), None)["exited"],
            true
        );
    }

    #[test]
    fn shell_recovery_after_a_failed_pi_preserves_the_observed_failure() {
        let mut r = record();
        r["status"] = Value::Null;
        r["foreground"] = json!({"pid":1,"argv":["pwsh","-NoExit","-Command","pi"]});
        r["labels"]["herdr.pi"] = json!({"version":1,"pid":7,"session":"s1","startup":"failed"})
            .to_string()
            .into();
        let agent = summary("remote/t1", &r, None);
        assert_eq!(agent["exited"], true);
        assert_eq!(agent["startup"], "failed");
        assert_eq!(agent["session"], Value::Null);
    }

    #[test]
    fn send_uses_identity_checked_pi_ipc_for_done_and_working_agents() {
        let mut r = record();
        r["labels"]["herdr.pi"] = json!({"version":1,"pid":7,"session":"s1","startup":"started","socket":"private-pipe","token":"private-token","node":"/node","request":"/request.mjs","hc":"/hc"}).to_string().into();
        let args = json!({"pid":7,"session":"s1","message":"follow-up"});
        for status in ["idle", "working", "done", "error"] {
            r["status"]["state"] = status.into();
            let params = send_params("remote/t1", &r, &args).unwrap();
            assert_eq!(params["on"], "remote");
            assert_eq!(
                params["argv"],
                json!(["/node", "/request.mjs", "t1", "7", "s1", "/hc"])
            );
            let input = base64::engine::general_purpose::STANDARD
                .decode(params["input"].as_str().unwrap())
                .unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&input).unwrap(),
                json!({"message":"follow-up"})
            );
            assert!(params.get("text").is_none());
            assert!(!params.to_string().contains("private-token"));
        }
        r["status"]["state"] = "blocked".into();
        assert!(send_params("remote/t1", &r, &args).is_err());
        r["status"]["state"] = "done".into();
        r["labels"]["herdr.pi"] = json!({"version":1,"pid":7,"session":"s1","startup":"started"})
            .to_string()
            .into();
        assert!(send_params("remote/t1", &r, &args).is_err());
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
