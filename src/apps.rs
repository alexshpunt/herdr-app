//! Apps that mods register in their mod.json (`"app"`: one object or a list):
//! the buttons a tab bar offers for a pane, when each one is available there,
//! and which links open in it. An app opens inside a pane (`pane.app.open`).

use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// One app a mod registers.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Registration {
    /// Unique within its mod; default: the mod's name.
    #[serde(default)]
    pub id: Option<String>,
    pub label: String,
    /// An SVG or PNG in the mod's folder.
    #[serde(default)]
    pub icon: Option<String>,
    /// Lower first, in the tab bar and when links are matched.
    #[serde(default = "default_order")]
    pub order: i32,
    /// All must hold for the pane's project.
    #[serde(default)]
    pub when: Vec<Rule>,
    /// Links that open in this app; the first registration (by order) wins.
    #[serde(default)]
    pub links: Vec<LinkRule>,
}

fn default_order() -> i32 {
    100
}

/// A condition on the pane an app would open in.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum Rule {
    /// This file exists in the project (its Git work tree, else its folder).
    Has { has: String },
    /// The project's `origin` remote URL matches this regular expression.
    Remote { remote: String },
    /// The pane's terminal has this label, set by its program in front (a
    /// label whose JSON value names a `pid` counts while that process is in front).
    Label { label: String },
    /// The project is on this computer (`true`): here, or on a WSL machine
    /// (`editorAuthority` `wsl+…` in machines.json); `false`: elsewhere.
    Local { local: bool },
}

/// Which links open in an app: URLs matching `url`, or file or folder paths,
/// optionally only those where `has` exists (in the folder, or the file's
/// folder) and on this computer or not (`local`).
#[derive(Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct LinkRule {
    pub url: Option<String>,
    pub file: bool,
    pub folder: bool,
    pub has: Option<String>,
    pub local: Option<bool>,
}

/// A registration with the mod that made it.
#[derive(Clone, Debug, PartialEq)]
pub struct App {
    pub name: String,
    pub reg: Registration,
}

impl App {
    pub fn id(&self) -> &str {
        self.reg.id.as_deref().unwrap_or(&self.name)
    }

    /// As mods see it (`apps()`), with whether it is available for a pane.
    pub fn json(&self, available: bool) -> Value {
        json!({
            "mod": self.name, "app": self.id(), "label": self.reg.label, "order": self.reg.order,
            "icon": self.reg.icon.as_ref().map(|i| format!("mods/{}/{}", self.name, i.trim_start_matches("./"))),
            "available": available,
        })
    }
}

/// A mod.json's `"app"`: one registration or a list. Malformed ones are
/// skipped with a warning; the mod still loads.
pub fn parse(name: &str, v: &Value) -> Vec<App> {
    let list = match v {
        Value::Null => return Vec::new(),
        Value::Array(list) => list.clone(),
        one => vec![one.clone()],
    };
    list.into_iter()
        .filter_map(|r| {
            match serde_json::from_value::<Registration>(r)
                .map_err(|e| e.to_string())
                .and_then(|reg| check_patterns(&reg).map(|()| reg))
            {
                Ok(reg) => Some(App {
                    name: name.to_owned(),
                    reg,
                }),
                Err(e) => {
                    tracing::warn!("mods/{name}/mod.json: an app registration is malformed: {e}");
                    None
                }
            }
        })
        .collect()
}

/// Every `remote` and `url` pattern compiles, so a typo is reported once
/// instead of never matching.
fn check_patterns(reg: &Registration) -> Result<(), String> {
    let remotes = reg.when.iter().filter_map(|r| match r {
        Rule::Remote { remote } => Some(remote),
        _ => None,
    });
    let urls = reg.links.iter().filter_map(|l| l.url.as_ref());
    for pattern in remotes.chain(urls) {
        fancy_regex::Regex::new(pattern).map_err(|e| format!("{pattern:?}: {e}"))?;
    }
    Ok(())
}

/// Every app the mods register, in order.
pub fn sorted(mut apps: Vec<App>) -> Vec<App> {
    apps.sort_by(|a, b| (a.reg.order, &a.name, a.id()).cmp(&(b.reg.order, &b.name, b.id())));
    apps
}

/// The files `has` rules ask about, for one probe of a folder.
pub fn probed_files(apps: &[App]) -> Vec<String> {
    let mut out = BTreeSet::new();
    for a in apps {
        for r in &a.reg.when {
            if let Rule::Has { has } = r {
                out.insert(has.clone());
            }
        }
        out.extend(a.reg.links.iter().filter_map(|l| l.has.clone()));
    }
    out.into_iter().collect()
}

/// What a folder on its machine has: which of the probed files exist, and its
/// Git `origin` remote.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Probe {
    pub found: BTreeSet<String>,
    pub origin: Option<String>,
}

/// Where an app would open: the pane's project and terminal.
pub struct Place<'a> {
    pub local: bool,
    /// The terminal's labels (`terminals()`), null for a mod pane.
    pub labels: &'a Value,
    pub foreground_pid: Option<u64>,
    /// None until the project's folder was looked at.
    pub probe: Option<&'a Probe>,
}

/// Whether `text` matches `pattern`. Each pattern compiles once per thread:
/// `apps()` checks the `remote` rules of every pane on every publish.
fn matches(pattern: &str, text: &str) -> bool {
    thread_local! {
        static COMPILED: std::cell::RefCell<std::collections::HashMap<String, Option<fancy_regex::Regex>>> =
            std::cell::RefCell::new(std::collections::HashMap::new());
    }
    COMPILED.with_borrow_mut(|compiled| {
        compiled
            .entry(pattern.to_owned())
            .or_insert_with(|| fancy_regex::Regex::new(pattern).ok())
            .as_ref()
            .is_some_and(|re| re.is_match(text).unwrap_or(false))
    })
}

/// Whether a label counts: set, and when its JSON value names a `pid`, set by
/// the process in front of the terminal now.
fn label_holds(labels: &Value, name: &str, foreground_pid: Option<u64>) -> bool {
    let Some(value) = labels
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    match serde_json::from_str::<Value>(value)
        .ok()
        .and_then(|v| v.get("pid").and_then(Value::as_u64))
    {
        Some(pid) => foreground_pid == Some(pid),
        None => true,
    }
}

/// Whether an app's button shows for this pane.
pub fn available(app: &App, place: &Place) -> bool {
    app.reg.when.iter().all(|rule| match rule {
        Rule::Has { has } => place.probe.is_some_and(|p| p.found.contains(has)),
        Rule::Remote { remote } => place
            .probe
            .and_then(|p| p.origin.as_deref())
            .is_some_and(|o| matches(remote, o)),
        Rule::Label { label } => label_holds(place.labels, label, place.foreground_pid),
        Rule::Local { local } => place.local == *local,
    })
}

/// Whether the link files and folders are checked for: a `has` in some rule
/// that could take it.
pub fn link_needs_probe(apps: &[App], link: &Value) -> bool {
    let kind = link["kind"].as_str().unwrap_or_default();
    apps.iter()
        .flat_map(|a| &a.reg.links)
        .any(|r| r.has.is_some() && ((r.file && kind == "file") || (r.folder && kind == "folder")))
}

/// Whether an app opens this link (`kind`: url, file or folder), given where
/// it is (`local`) and what its folder has (`probe`).
pub fn opens(app: &App, link: &Value, local: bool, probe: Option<&Probe>) -> bool {
    let kind = link["kind"].as_str().unwrap_or_default();
    app.reg.links.iter().any(|r| {
        let kind_ok = match kind {
            "url" => r
                .url
                .as_deref()
                .is_some_and(|re| matches(re, link["url"].as_str().unwrap_or_default())),
            "file" => r.file,
            "folder" => r.folder,
            _ => false,
        };
        kind_ok
            && r.local.is_none_or(|l| l == local)
            && r.has
                .as_ref()
                .is_none_or(|h| probe.is_some_and(|p| p.found.contains(h)))
    })
}

/// The folder a file or folder link's `has` is looked for in: a file's folder, or the folder.
pub fn link_folder(link: &Value) -> Option<String> {
    let path = link["path"].as_str()?;
    if link["kind"] != "file" {
        return Some(path.to_owned());
    }
    let cut = path.rfind(['/', '\\'])?;
    Some(if cut == 0 {
        "/".to_owned()
    } else if path[..cut].ends_with(':') {
        format!("{}\\", &path[..cut])
    } else {
        path[..cut].to_owned()
    })
}

/// Looks at a folder on this computer.
pub fn probe_here(root: &str, files: &[String]) -> Probe {
    let found = files
        .iter()
        .filter(|f| std::path::Path::new(root).join(f).exists())
        .cloned()
        .collect();
    let origin = crate::mods::run_in(
        root,
        "git",
        &["remote".into(), "get-url".into(), "origin".into()],
    )
    .map(|s| s.trim().to_owned())
    .filter(|s| !s.is_empty());
    Probe { found, origin }
}

/// Looks at a folder on another machine with one `sh` there (a machine without
/// it finds nothing).
pub fn probe_on(machine: &str, root: &str, files: &[String]) -> Probe {
    const SCRIPT: &str = r#"cd "$1" 2>/dev/null || exit 0; shift; for f; do [ -e "$f" ] && printf 'has %s\n' "$f"; done; o=$(git remote get-url origin 2>/dev/null) && printf 'origin %s\n' "$o"; exit 0"#;
    let mut args = vec![
        "-c".to_owned(),
        SCRIPT.to_owned(),
        "sh".to_owned(),
        root.to_owned(),
    ];
    args.extend(files.iter().cloned());
    match crate::mods::run_remote(machine, "sh", &args, None) {
        Ok((_, out, _)) => parse_probe(&String::from_utf8_lossy(&out)),
        Err(e) => {
            tracing::debug!("cannot look at {root} on {machine}: {e}");
            Probe::default()
        }
    }
}

fn parse_probe(out: &str) -> Probe {
    let mut probe = Probe::default();
    for line in out.lines() {
        if let Some(f) = line.strip_prefix("has ") {
            probe.found.insert(f.to_owned());
        } else if let Some(o) = line.strip_prefix("origin ") {
            probe.origin = Some(o.trim().to_owned()).filter(|o| !o.is_empty());
        }
    }
    probe
}

/// The machines whose folders this computer opens (WSL: `editorAuthority`
/// `wsl+…` in the home folder's machines.json).
/// Read again at most every few seconds: `apps()` asks on every publish.
pub fn local_machines() -> BTreeSet<String> {
    type Cache = Option<(std::time::Instant, BTreeSet<String>)>;
    static CACHE: std::sync::Mutex<Cache> = std::sync::Mutex::new(None);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, set)) = cache.as_ref()
        && at.elapsed() < std::time::Duration::from_secs(5)
    {
        return set.clone();
    }
    let text =
        std::fs::read_to_string(crate::mods::app_dir().join("machines.json")).unwrap_or_default();
    let set = wsl_machines(&text);
    *cache = Some((std::time::Instant::now(), set.clone()));
    set
}

fn wsl_machines(machines_json: &str) -> BTreeSet<String> {
    let list: Vec<Value> = serde_json::from_str(machines_json).unwrap_or_default();
    list.iter()
        .filter(|m| {
            m["editorAuthority"]
                .as_str()
                .is_some_and(|a| a.starts_with("wsl+"))
        })
        .filter_map(|m| m["name"].as_str().map(str::to_owned))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apps(v: Value) -> Vec<App> {
        sorted(
            v.as_object()
                .unwrap()
                .iter()
                .flat_map(|(name, regs)| parse(name, regs))
                .collect(),
        )
    }

    fn shipped() -> Vec<App> {
        apps(json!({
            "vscode": { "id": "files", "label": "Files", "order": 30, "links": [{ "file": true }, { "folder": true }] },
            "unity": { "label": "Unity", "order": 20, "when": [{ "local": true }, { "has": "ProjectSettings/ProjectVersion.txt" }],
                       "links": [{ "folder": true, "local": true, "has": "ProjectSettings/ProjectVersion.txt" }] },
            "linear": { "label": "Linear", "order": 50, "when": [{ "has": ".linear-project" }], "links": [{ "url": "^https://linear\\.app/" }] },
            "github": { "label": "GitHub", "order": 60, "when": [{ "remote": "github\\.com[:/]" }], "links": [{ "url": "^https://github\\.com/" }] },
            "plannotator-browser": [
                { "id": "review", "label": "Annotate diff", "order": 10, "when": [{ "label": "herdr.plannotator" }] },
                { "id": "last", "label": "Annotate reply", "order": 11, "when": [{ "label": "herdr.plannotator" }] }
            ],
            "broken": { "id": 3 },
            "typo": { "label": "Typo", "links": [{ "url": "^https://(" }] }
        }))
    }

    #[test]
    fn mods_register_one_app_or_several_in_order() {
        let all = shipped();
        let ids: Vec<(&str, &str)> = all.iter().map(|a| (a.name.as_str(), a.id())).collect();
        assert_eq!(
            ids,
            [
                ("plannotator-browser", "review"),
                ("plannotator-browser", "last"),
                ("unity", "unity"),
                ("vscode", "files"),
                ("linear", "linear"),
                ("github", "github")
            ]
        );
        assert_eq!(
            probed_files(&shipped()),
            [".linear-project", "ProjectSettings/ProjectVersion.txt"]
        );
        let json = shipped()[3].json(true);
        assert_eq!(
            json,
            json!({ "mod": "vscode", "app": "files", "label": "Files", "order": 30, "icon": null, "available": true })
        );
    }

    #[test]
    fn a_button_shows_when_the_panes_project_has_what_it_needs() {
        let all = shipped();
        let labels = json!({ "herdr.plannotator": "{\"pid\":42,\"node\":\"node\"}" });
        let probe = Probe {
            found: [".linear-project".to_owned()].into(),
            origin: Some("git@github.com:me/app.git".into()),
        };
        let shown = |place: &Place| {
            all.iter()
                .filter(|a| available(a, place))
                .map(App::id)
                .collect::<Vec<_>>()
        };
        let here = Place {
            local: true,
            labels: &labels,
            foreground_pid: Some(42),
            probe: Some(&probe),
        };
        assert_eq!(
            shown(&here),
            ["review", "last", "files", "linear", "github"]
        );
        // The Pi that set the label is no longer in front; nothing looked at yet.
        let none = Place {
            local: false,
            labels: &labels,
            foreground_pid: Some(7),
            probe: None,
        };
        assert_eq!(shown(&none), ["files"]);
        let unity = Probe {
            found: ["ProjectSettings/ProjectVersion.txt".to_owned()].into(),
            origin: None,
        };
        let game = Place {
            local: true,
            labels: &Value::Null,
            foreground_pid: None,
            probe: Some(&unity),
        };
        assert_eq!(shown(&game), ["unity", "files"]);
        assert_eq!(
            shown(&Place {
                local: false,
                ..game
            }),
            ["files"]
        );
    }

    #[test]
    fn a_link_opens_in_the_first_app_that_takes_it() {
        let all = shipped();
        let first = |link: Value, local: bool, probe: Option<&Probe>| {
            all.iter()
                .find(|a| opens(a, &link, local, probe))
                .map(App::id)
        };
        assert_eq!(
            first(
                json!({ "kind": "url", "url": "https://linear.app/x/issue/A-1" }),
                true,
                None
            ),
            Some("linear")
        );
        assert_eq!(
            first(
                json!({ "kind": "url", "url": "https://github.com/me/app/pull/1" }),
                true,
                None
            ),
            Some("github")
        );
        assert_eq!(
            first(
                json!({ "kind": "url", "url": "https://example.com/" }),
                true,
                None
            ),
            None
        );
        assert_eq!(
            first(json!({ "kind": "file", "path": "/src/a.rs" }), false, None),
            Some("files")
        );
        let unity = Probe {
            found: ["ProjectSettings/ProjectVersion.txt".to_owned()].into(),
            origin: None,
        };
        let folder = json!({ "kind": "folder", "path": "C:\\game" });
        assert_eq!(first(folder.clone(), true, Some(&unity)), Some("unity"));
        assert_eq!(first(folder.clone(), false, Some(&unity)), Some("files"));
        assert_eq!(first(folder.clone(), true, None), Some("files"));
        assert!(link_needs_probe(&all, &folder));
        assert!(!link_needs_probe(
            &all,
            &json!({ "kind": "file", "path": "/a" })
        ));
    }

    #[test]
    fn link_folders_and_probes_read_as_expected() {
        assert_eq!(
            link_folder(&json!({ "kind": "file", "path": "/src/a.rs" })).as_deref(),
            Some("/src")
        );
        assert_eq!(
            link_folder(&json!({ "kind": "file", "path": "C:\\a.rs" })).as_deref(),
            Some("C:\\")
        );
        assert_eq!(
            link_folder(&json!({ "kind": "file", "path": "/a.rs" })).as_deref(),
            Some("/")
        );
        assert_eq!(
            link_folder(&json!({ "kind": "folder", "path": "/src" })).as_deref(),
            Some("/src")
        );
        let p = parse_probe("has .linear-project\norigin https://github.com/me/app\n");
        assert_eq!(
            p,
            Probe {
                found: [".linear-project".to_owned()].into(),
                origin: Some("https://github.com/me/app".into())
            }
        );
        let machines = r#"[{"name":"laptop-wsl","editorAuthority":"wsl+Ubuntu"},{"name":"vps","target":"mesh-vps"}]"#;
        assert_eq!(wsl_machines(machines), ["laptop-wsl".to_owned()].into());
        assert!(wsl_machines("not json").is_empty());
    }
}
