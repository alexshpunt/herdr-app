//! Reverse App requests over the existing authenticated core connection.
//! The route stays in private terminal labels; tools never expose it.
use crate::{
    hc::{self, Core},
    mods,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    hash::{BuildHasher, Hasher},
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const LIMIT: usize = 900 * 1024;
const QUEUE: usize = 8;
const TTL: u64 = 120_000;

fn random_id() -> String {
    let random = || {
        std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish()
    };
    format!("{:016x}{:016x}", random(), random())
}
fn identity() -> &'static (String, String) {
    static ID: OnceLock<(String, String)> = OnceLock::new();
    ID.get_or_init(|| {
        let host = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_default();
        let home = mods::app_dir();
        (
            format!(
                "{:x}",
                Sha256::digest(format!("{host}\n{}", home.display()))
            ),
            random_id(),
        )
    })
}
pub fn new_route() -> Value {
    let (app, epoch) = identity();
    json!({"version":1,"app":app,"epoch":epoch,"mailbox":format!("ho.{}", &random_id()[..28])})
}
fn route(record: &Value) -> Option<Value> {
    let value: Value = serde_json::from_str(record["labels"]["herdr.app"].as_str()?).ok()?;
    let name = value["mailbox"].as_str()?;
    (value["version"] == 1
        && value["app"].is_string()
        && value["epoch"].is_string()
        && name.strip_prefix("ho.").is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 28
                && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        }))
    .then_some(value)
}
/// Re-read ownership before updating a cached route. terminal.run puts routes
/// on newly created terminals atomically; this path covers adoption/restart.
pub fn publish(core: &Core, address: &str, expected: &Value) -> anyhow::Result<()> {
    let record = core.call("terminal.get", json!({"terminal":address}))?;
    if let Some(raw) = record["labels"]["herdr.app"].as_str() {
        let previous: Value = serde_json::from_str(raw)?;
        anyhow::ensure!(
            previous["app"] == expected["app"],
            "This terminal is routed to another App"
        );
    }
    core.call(
        "terminal.label",
        json!({"terminal":address,"labels":{"herdr.app":expected.to_string()}}),
    )?;
    Ok(())
}
pub enum Work {
    Route(Value),
    Request(Value),
}
#[derive(Default)]
pub struct State {
    routes: HashMap<String, Value>,
    routing: HashSet<String>,
    triggers: HashMap<String, String>,
}
impl State {
    pub fn retain(&mut self, live: &HashMap<String, Value>) {
        self.routes.retain(|address, _| live.contains_key(address));
        self.routing.retain(|address| live.contains_key(address));
        self.triggers
            .retain(|address, _| live.contains_key(address));
    }
    pub fn reconnected(&mut self) {
        self.routing.clear();
        self.triggers.clear();
    }
    pub fn routed(&mut self, address: &str) {
        self.routing.remove(address);
    }
    pub fn plan(&mut self, address: &str, record: &Value) -> Option<Work> {
        let (app, epoch) = identity();
        let existing = route(record);
        // An explicit route belonging to another App/home is never taken over,
        // even if its protocol version is unknown to us.
        if let Some(raw) = record["labels"]["herdr.app"].as_str() {
            let parsed: Value = serde_json::from_str(raw).ok()?;
            if parsed["app"] != *app {
                return None;
            }
        }
        let mut desired = existing
            .clone()
            .or_else(|| self.routes.get(address).cloned())
            .unwrap_or_else(new_route);
        desired["epoch"] = json!(epoch);
        self.routes.insert(address.into(), desired.clone());
        if existing.as_ref() != Some(&desired) {
            if self.routing.insert(address.into()) {
                return Some(Work::Route(desired));
            }
            return None;
        }
        let trigger = record["labels"]["herdr.app.request"].as_str()?;
        if trigger.is_empty() || self.triggers.get(address).is_some_and(|old| old == trigger) {
            return None;
        }
        self.triggers.insert(address.into(), trigger.into());
        Some(Work::Request(desired))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn on(address: &str) -> Option<&str> {
    address.split_once('/').map(|(machine, _)| machine)
}
fn document(core: &Core, address: &str, route: &Value) -> anyhow::Result<(Value, u64)> {
    let result = core.call("doc.get", json!({"name":route["mailbox"],"on":on(address)}))?;
    let version = result["version"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("Mailbox response has no version"))?;
    Ok((result["value"].clone(), version))
}
fn write(
    core: &Core,
    address: &str,
    route: &Value,
    value: &Value,
    version: u64,
) -> anyhow::Result<Value> {
    core.call(
        "doc.set",
        json!({"name":route["mailbox"],"on":on(address),"version":version,"value":value}),
    )
}
fn valid_document(value: &Value, route: &Value) -> bool {
    value["version"] == 1
        && value["epoch"] == route["epoch"]
        && value["requests"]
            .as_object()
            .is_some_and(|requests| requests.len() <= QUEUE)
        && serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= LIMIT)
}
fn valid_wire(wire: &Value) -> bool {
    let Some(fields) = wire.as_object() else {
        return false;
    };
    if wire["ls"] == true {
        return fields.len() == 1;
    }
    fields.len() == 2
        && wire["args"].is_object()
        && matches!(
            wire["do"].as_str(),
            Some(
                "workflow.get"
                    | "agent.list"
                    | "agent.inspect"
                    | "agent.send"
                    | "agent.stop"
                    | "agent.remove"
                    | "space.new"
                    | "tab.new"
            )
        )
}
fn valid_request(id: &str, request: &Value, record: &Value, now: u64) -> bool {
    let label = crate::agents::pi_label(record);
    let Some(label) = label else { return false };
    !id.is_empty()
        && id.len() <= 80
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && crate::agents::current_pi(record)
        && request["pid"] == label["pid"]
        && request["session"] == label["session"]
        && request["expires"]
            .as_u64()
            .is_some_and(|expires| expires > now && expires <= now.saturating_add(TTL))
        && valid_wire(&request["wire"])
}
pub fn targets_caller(wire: &Value, address: &str) -> bool {
    matches!(
        wire["do"].as_str(),
        Some("agent.send" | "agent.stop" | "agent.remove")
    ) && wire["args"]["terminal"] == address
}
pub struct Claim {
    pub id: String,
    pub wire: Value,
    accepted: Value,
}
fn claim_document(
    value: &mut Value,
    route: &Value,
    record: &Value,
    now: u64,
) -> anyhow::Result<(Vec<Claim>, bool)> {
    anyhow::ensure!(
        valid_document(value, route),
        "Mailbox version, epoch or bounds are invalid"
    );
    let mut claims = Vec::new();
    let mut changed = false;
    for (id, request) in value["requests"].as_object_mut().expect("validated") {
        if request["state"] != "ready" {
            continue;
        }
        changed = true;
        if valid_request(id, request, record, now) {
            request["state"] = json!("accepted");
            claims.push(Claim {
                id: id.clone(),
                wire: request["wire"].clone(),
                accepted: request.clone(),
            });
        } else {
            request["state"] = json!("done");
            request["result"] = json!({"error":"App request expired or its caller identity/command is invalid. Inspect Herdr before retrying."});
        }
    }
    anyhow::ensure!(
        serde_json::to_vec(value)?.len() <= LIMIT,
        "Mailbox needs space for its acceptance records"
    );
    Ok((claims, changed))
}
/// Only an explicit CAS conflict is retried. Unknown writes never dispatch.
pub fn claim(core: &Core, address: &str, expected: &Value) -> anyhow::Result<Vec<Claim>> {
    for _ in 0..16 {
        let record = core.call("terminal.get", json!({"terminal":address}))?;
        anyhow::ensure!(
            route(&record).as_ref() == Some(expected),
            "The App route changed"
        );
        let (mut value, version) = document(core, address, expected)?;
        let (claims, changed) = claim_document(&mut value, expected, &record, now_ms())?;
        if !changed {
            return Ok(Vec::new());
        }
        match write(core, address, expected, &value, version) {
            Ok(_) => return Ok(claims),
            Err(error) if hc::error_kind(&error) == Some("conflict") => continue,
            Err(error) => return Err(error),
        }
    }
    anyhow::bail!("Mailbox changed repeatedly; no request was dispatched")
}
pub fn finish(
    core: &Core,
    address: &str,
    route: &Value,
    claim: Claim,
    result: Value,
) -> anyhow::Result<()> {
    for _ in 0..16 {
        let (mut value, version) = document(core, address, route)?;
        anyhow::ensure!(
            valid_document(&value, route),
            "The mailbox epoch changed before completion"
        );
        anyhow::ensure!(
            value["requests"][&claim.id] == claim.accepted,
            "The accepted request changed before completion"
        );
        value["requests"][&claim.id]["state"] = json!("done");
        value["requests"][&claim.id]["result"] = result.clone();
        if serde_json::to_vec(&value)?.len() > LIMIT {
            value["requests"][&claim.id]["result"] = json!({"error":"App handled the request, but its result exceeds the mailbox limit. Inspect Herdr; do not repeat an unconfirmed mutation.","outcome":"unknown"});
        }
        anyhow::ensure!(serde_json::to_vec(&value)?.len() <= LIMIT, "App completed the request, but its response cannot fit in the mailbox; completion is unconfirmed");
        match write(core, address, route, &value, version) {
            Ok(_) => return Ok(()),
            Err(error) if hc::error_kind(&error) == Some("conflict") => continue,
            Err(error) => return Err(error),
        }
    }
    anyhow::bail!("Mailbox completion could not be confirmed")
}
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(105);

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> Value {
        json!({"state":"live","foreground":{"pid":7},"labels":{"herdr.pi":json!({"version":1,"pid":7,"session":"s1","startup":"started"}).to_string()}})
    }
    fn request() -> Value {
        json!({"pid":7,"session":"s1","expires":2000,"state":"ready","wire":{"do":"agent.inspect","args":{"terminal":"t2"}}})
    }
    fn document(route: &Value) -> Value {
        json!({"version":1,"epoch":route["epoch"],"requests":{"request-1":request()}})
    }
    #[test]
    fn only_the_narrow_app_protocol_is_accepted() {
        let route = new_route();
        let name = route["mailbox"].as_str().unwrap();
        assert!(name.len() <= 32, "core document names are at most 32 bytes");
        assert!(name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"-_.".contains(&c)));
        assert!(valid_wire(&json!({"ls":true})));
        assert!(valid_wire(&json!({"do":"space.new","args":{}})));
        for wire in [
            json!({"shot":"secret"}),
            json!({"ls":true,"do":"app.quit"}),
            json!({"do":"app.quit","args":{}}),
            json!({"do":"agent.remove","args":null}),
        ] {
            assert!(!valid_wire(&wire));
        }
    }
    #[test]
    fn a_remote_caller_cannot_mutate_its_own_agent() {
        for action in ["agent.send", "agent.stop", "agent.remove"] {
            assert!(targets_caller(
                &json!({"do":action,"args":{"terminal":"remote/t1"}}),
                "remote/t1"
            ));
            assert!(!targets_caller(
                &json!({"do":action,"args":{"terminal":"other/t1"}}),
                "remote/t1"
            ));
        }
        assert!(!targets_caller(
            &json!({"do":"agent.inspect","args":{"terminal":"remote/t1"}}),
            "remote/t1"
        ));
    }
    #[test]
    fn claims_require_current_pid_session_deadline_and_epoch() {
        let route = new_route();
        let record = record();
        let mut value = document(&route);
        let (claims, changed) = claim_document(&mut value, &route, &record, 1000).unwrap();
        assert!(changed);
        assert_eq!(claims.len(), 1);
        assert_eq!(value["requests"]["request-1"]["state"], "accepted");
        assert!(claim_document(&mut value, &route, &record, 1000)
            .unwrap()
            .0
            .is_empty());
        for (key, invalid) in [
            ("pid", json!(8)),
            ("session", json!("other")),
            ("expires", json!(999)),
            ("expires", json!(200000)),
        ] {
            let mut value = document(&route);
            value["requests"]["request-1"][key] = invalid;
            assert!(claim_document(&mut value, &route, &record, 1000)
                .unwrap()
                .0
                .is_empty());
            assert_eq!(value["requests"]["request-1"]["state"], "done");
        }
        let mut value = document(&route);
        value["epoch"] = json!("old");
        assert!(claim_document(&mut value, &route, &record, 1000).is_err());
        let mut stale = record.clone();
        stale["foreground"]["pid"] = json!(8);
        assert!(claim_document(&mut document(&route), &route, &stale, 1000)
            .unwrap()
            .0
            .is_empty());
    }
    #[test]
    fn mailbox_queue_and_size_are_bounded() {
        let route = new_route();
        let mut value = document(&route);
        for n in 0..QUEUE {
            value["requests"][format!("extra-{n}")] = request();
        }
        assert!(!valid_document(&value, &route));
        let mut value = document(&route);
        value["requests"]["request-1"]["wire"]["args"]["text"] = json!("x".repeat(LIMIT));
        assert!(!valid_document(&value, &route));
    }
    #[test]
    fn routes_do_not_take_over_another_app_and_triggers_are_once_only() {
        let route = new_route();
        let mut state = State::default();
        let mut record = record();
        let mut foreign = route.clone();
        foreign["app"] = json!("other");
        record["labels"]["herdr.app"] = json!(foreign.to_string());
        assert!(state.plan("t1", &record).is_none());
        record["labels"]["herdr.app"] = json!(route.to_string());
        record["labels"]["herdr.app.request"] = json!("one");
        assert!(matches!(state.plan("t1", &record), Some(Work::Request(_))));
        assert!(state.plan("t1", &record).is_none());
        record["labels"]["herdr.app.request"] = json!("two");
        assert!(matches!(state.plan("t1", &record), Some(Work::Request(_))));
        let mut stale = route.clone();
        stale["epoch"] = json!("old");
        record["labels"]["herdr.app"] = json!(stale.to_string());
        match state.plan("t1", &record) {
            Some(Work::Route(new)) => {
                assert_eq!(new["mailbox"], route["mailbox"]);
                assert_eq!(new["epoch"], route["epoch"]);
            }
            _ => panic!("own route must refresh"),
        }
    }
}
