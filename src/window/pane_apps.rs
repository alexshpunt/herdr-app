//! Apps inside panes (`pane.app.*`): opening them, which ones the mods
//! register and where each is available (`apps()`), and links routed to them.

use super::*;
use crate::apps::{self, App, Place, Probe};

/// How long a folder's probe answers `has` and `remote` rules before it is looked at again.
const PROBE_AGE: Duration = Duration::from_secs(15);

/// Looks at a folder off the UI thread. GPUI tests can't have other threads:
/// there it runs at once, and `probe` finds nothing.
fn look_off_thread(look: impl FnOnce() + Send + 'static) {
    #[cfg(not(test))]
    std::thread::spawn(look);
    #[cfg(test)]
    look();
}

/// Looks at a folder here or on its machine.
#[cfg(not(test))]
fn probe(machine: Option<&str>, folder: &str, files: &[String]) -> Probe {
    match machine {
        Some(m) => apps::probe_on(m, folder, files),
        None => apps::probe_here(folder, files),
    }
}

#[cfg(test)]
fn probe(_machine: Option<&str>, _folder: &str, _files: &[String]) -> Probe {
    Probe::default()
}

impl AppWindow {
    /// `pane.app.open`: a mod as an app in a pane (default: the focused one),
    /// shown there at once. The app of the same registration the pane already
    /// holds is reused: its running copy gets the new props from `nextLink()`.
    /// Its props get `project` (the pane's project) unless the opener gave one.
    pub(super) fn open_app(&mut self, a: &Value) -> Result<Value, String> {
        let name = Self::owned(a, "mod").ok_or("pane.app.open needs mod")?;
        if !self.folders.contains_key(&name) {
            return Err(format!("no mod {name:?} in mods/"));
        }
        let pane = match (Self::owned(a, "pane"), Self::arg(a, "terminal")) {
            (Some(pane), _) => pane,
            (None, Some(terminal)) => self
                .model
                .pane_of(terminal)
                .ok_or_else(|| format!("no pane shows terminal {terminal:?}"))?,
            (None, None) => self
                .model
                .focused_pane()
                .ok_or("no pane to open the app in")?,
        };
        if !self
            .model
            .tab_of(&pane)
            .is_some_and(|t| t.root.find(&pane).is_some_and(Node::is_pane))
        {
            return Err(format!("no pane {pane:?}"));
        }
        // A mod that registers one app: that one, named or not.
        let registered: Vec<App> = self
            .registered_apps()
            .into_iter()
            .filter(|r| r.name == name)
            .collect();
        let registration = match Self::arg(a, "app") {
            Some(id) if !registered.is_empty() && !registered.iter().any(|r| r.id() == id) => {
                return Err(format!("mod {name:?} registers no app {id:?}"));
            }
            Some(id) => Some(id.to_owned()),
            None if registered.len() == 1 => Some(registered[0].id().to_owned()),
            None => None,
        };
        let title = Self::owned(a, "title").or_else(|| {
            registration
                .as_ref()
                .and_then(|id| registered.iter().find(|r| r.id() == id))
                .map(|r| r.reg.label.clone())
        });
        let machine = self.machine_of_node(&pane);
        self.require_document(machine.as_deref())?;
        let mut props = a.get("props").cloned().unwrap_or(Value::Null);
        if let Some((machine, folder)) = self.pane_project(&pane)
            && (props.is_object() || props.is_null())
            && props.get("project").is_none()
        {
            if props.is_null() {
                props = json!({});
            }
            props["project"] = json!({ "folder": folder, "machine": machine });
        }
        let fresh = self.model.fresh_id_on("a", machine.as_deref());
        let (app, reused) = self
            .model
            .open_app(
                &pane,
                &name,
                registration.as_deref(),
                props.clone(),
                title,
                fresh,
            )
            .ok_or_else(|| format!("no pane {pane:?}"))?;
        if reused
            && !props.is_null()
            && let Some(copy) = self.copies.get(&app).filter(|c| c.root.is_some())
        {
            mods::send_link_to(copy.id, props);
        }
        self.focused_block = None;
        self.focused_pane = None;
        Ok(json!({ "pane": pane, "app": app, "reused": reused }))
    }

    /// Some registered app opens files or folders on other machines (its `links`).
    pub(super) fn apps_open_remote_paths(&self) -> bool {
        self.registered_apps()
            .iter()
            .flat_map(|a| &a.reg.links)
            .any(|l| (l.file || l.folder) && l.local != Some(true))
    }

    /// Every app the installed mods register (mod.json `"app"`), in order.
    pub(super) fn registered_apps(&self) -> Vec<App> {
        apps::sorted(
            self.folders
                .values()
                .flat_map(|f| f.apps.iter().cloned())
                .collect(),
        )
    }

    /// A pane's project, as (machine, folder): its terminal's Git work tree,
    /// else its terminal's folder, else its space's folder.
    pub(super) fn pane_project(&self, pane: &str) -> Option<(Option<String>, String)> {
        let space = self.model.space_of(pane)?;
        let address = self.model.address_of(pane);
        let machine = address
            .as_deref()
            .and_then(|a| a.split_once('/'))
            .map(|(m, _)| m.to_owned())
            .or_else(|| space.machine.clone());
        let folder = address
            .as_ref()
            .and_then(|a| {
                self.model
                    .folder_info
                    .get(a)
                    .map(|f| f.top.clone())
                    .or_else(|| self.cwds.get(a).cloned())
            })
            .unwrap_or_else(|| space.folder.clone());
        (!folder.is_empty()).then_some((machine, folder))
    }

    /// What a folder has for the apps' rules. One looked at a while ago, or
    /// never, is looked at again off the UI thread (`Request::AppProbe`); until
    /// then the last answer counts.
    fn folder_probe(
        &mut self,
        machine: Option<String>,
        folder: String,
        files: &[String],
    ) -> Option<Probe> {
        let key = (machine, folder);
        let fresh = self
            .app_probes
            .get(&key)
            .is_some_and(|p| p.at.elapsed() < PROBE_AGE);
        if !fresh {
            let last = self.app_probes.get(&key).and_then(|p| p.probe.clone());
            self.app_probes.insert(
                key.clone(),
                AppProbe {
                    at: std::time::Instant::now(),
                    probe: last,
                },
            );
            let (machine, folder) = key.clone();
            let files = files.to_vec();
            look_off_thread(move || {
                let probe = probe(machine.as_deref(), &folder, &files);
                mods::request(Request::AppProbe {
                    machine,
                    folder,
                    probe,
                });
            });
        }
        self.app_probes.get(&key).and_then(|p| p.probe.clone())
    }

    /// A folder looked at: the apps available change with it.
    pub(super) fn app_probed(
        &mut self,
        machine: Option<String>,
        folder: String,
        probe: Probe,
        cx: &mut Context<Self>,
    ) {
        let slot = self
            .app_probes
            .entry((machine, folder))
            .or_insert(AppProbe {
                at: std::time::Instant::now(),
                probe: None,
            });
        if slot.probe.as_ref() != Some(&probe) {
            slot.probe = Some(probe);
            self.publish(cx);
        }
    }

    /// What `apps()` reads: every registered app, and for each pane the
    /// ones available there, as `[mod, app]`.
    pub(super) fn apps_snapshot(&mut self) -> Value {
        let all = self.registered_apps();
        let files = apps::probed_files(&all);
        let looks = !files.is_empty()
            || all.iter().any(|a| {
                a.reg
                    .when
                    .iter()
                    .any(|r| matches!(r, apps::Rule::Remote { .. }))
            });
        let locals = apps::local_machines();
        let panes: Vec<String> = self
            .model
            .tabs()
            .flat_map(|t| t.root.panes())
            .map(|n| n.id.clone())
            .collect();
        let mut available = serde_json::Map::new();
        for pane in panes {
            let project = self.pane_project(&pane);
            let probe = match (&project, looks) {
                (Some((machine, folder)), true) => {
                    self.folder_probe(machine.clone(), folder.clone(), &files)
                }
                _ => None,
            };
            let machine = project
                .map(|(m, _)| m)
                .unwrap_or_else(|| self.machine_of_node(&pane));
            let record = self.model.address_of(&pane).and_then(|a| self.live.get(&a));
            let place = Place {
                local: machine.as_deref().is_none_or(|m| locals.contains(m)),
                labels: record.and_then(|r| r.get("labels")).unwrap_or(&Value::Null),
                foreground_pid: record
                    .and_then(|r| r.pointer("/foreground/pid"))
                    .and_then(Value::as_u64),
                probe: probe.as_ref(),
            };
            let ids: Vec<Value> = all
                .iter()
                .filter(|a| apps::available(a, &place))
                .map(|a| json!([a.name, a.id()]))
                .collect();
            available.insert(pane, Value::Array(ids));
        }
        json!({ "apps": all.iter().map(|a| a.json(false)).collect::<Vec<_>>(), "available": available })
    }

    /// Opens a link in the app the first registration that takes it names, in
    /// the pane of the terminal it came from, else the focused pane. A file or
    /// folder that `has` rules ask about is looked at first, off the UI thread.
    /// False: no app takes it.
    pub(super) fn open_link_in_app(
        &mut self,
        link: &Value,
        system: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let all = self.registered_apps();
        if all.is_empty() {
            return false;
        }
        let machine = link["machine"].as_str().map(str::to_owned);
        let local = machine
            .as_deref()
            .is_none_or(|m| apps::local_machines().contains(m));
        let probe: Option<Probe> = match link.get("probed") {
            Some(p) => serde_json::from_value::<Vec<String>>(p.clone())
                .ok()
                .map(|found| Probe {
                    found: found.into_iter().collect(),
                    origin: None,
                }),
            None if apps::link_needs_probe(&all, link) => {
                let Some(folder) = apps::link_folder(link) else {
                    return false;
                };
                let files = apps::probed_files(&all);
                let mut link = link.clone();
                look_off_thread(move || {
                    link["probed"] = json!(probe(machine.as_deref(), &folder, &files).found);
                    mods::request(Request::OpenLink { link, system });
                });
                return true;
            }
            None => None,
        };
        let Some(app) = all
            .iter()
            .find(|a| apps::opens(a, link, local, probe.as_ref()))
        else {
            return false;
        };
        let pane = link["terminal"]
            .as_str()
            .and_then(|t| self.model.pane_of(t))
            .or_else(|| self.model.focused_pane());
        let Some(pane) = pane else { return false };
        let mut shown = link.clone();
        if let Some(l) = shown.as_object_mut() {
            l.remove("probed");
        }
        let args =
            json!({ "mod": app.name, "app": app.id(), "pane": pane, "props": { "link": shown } });
        let reply = self.run_as("pane.app.open", args, false, window, cx);
        if let Some(error) = reply.get("error").and_then(Value::as_str) {
            tracing::warn!("cannot open the link in {}: {error}", app.reg.label);
            return false;
        }
        true
    }
}
