//! Apps as tabs (`app.open`, `app.beside`, `app.apart`): opening them for the
//! agent a pane works for, which ones the mods register and where each is
//! available (`apps()`), links routed to them, and closing them with their agent.

use super::*;
use crate::apps::{self, App, Place, Probe, Reuse};
use crate::model::AppQuery;

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
    /// `app.open`: a mod as an app in a tab of its own, shown at once. It is
    /// opened for the agent the pane of `for` (a terminal; default: the
    /// focused pane) works for (`Model::owner_of`): its tab goes after that
    /// agent's tab and its earlier tabs, and closes with it. Without an agent
    /// it is nobody's and goes after the selected tab. Its props get `app`
    /// (the registration), `origin` (the agent) and `project` (the agent's
    /// project, else that pane's) unless the opener gave one. An open app the
    /// registration's `reuse` (or the `reuse` argument) names is shown
    /// instead: its stored props take the new ones and its running copy gets
    /// them from `nextLink()`.
    pub(super) fn open_app(&mut self, a: &Value) -> Result<Value, String> {
        let name = Self::owned(a, "mod").ok_or("app.open needs mod")?;
        if !self.folders.contains_key(&name) {
            return Err(format!("no mod {name:?} in mods/"));
        }
        // A mod that registers one app: that one, named or not.
        let registered: Vec<App> = self
            .registered_apps()
            .into_iter()
            .filter(|r| r.name == name)
            .collect();
        let app = match Self::arg(a, "app") {
            Some(id) if !registered.is_empty() && !registered.iter().any(|r| r.id() == id) => {
                return Err(format!("mod {name:?} registers no app {id:?}"));
            }
            Some(id) => id.to_owned(),
            None if registered.len() == 1 => registered[0].id().to_owned(),
            // No button's: the mod itself (a review an agent opens).
            None => name.clone(),
        };
        let registration = registered.iter().find(|r| r.id() == app);
        let reuse = match a.get("reuse") {
            None | Some(Value::Null) => registration.map_or(Reuse::Agent, |r| r.reg.reuse),
            Some(v) => serde_json::from_value::<Reuse>(v.clone()).map_err(|_| {
                format!("app.open reuse is \"agent\", \"project\" or \"none\", not {v}")
            })?,
        };
        let from = match Self::arg(a, "for") {
            Some(t) => {
                let terminal = self
                    .link_source(t, Self::arg(a, "space"))
                    .ok_or_else(|| format!("no terminal {t:?}"))?;
                self.model
                    .pane_of(&terminal)
                    .ok_or_else(|| format!("terminal {terminal:?} has no pane"))?
            }
            None => self
                .model
                .focused_pane()
                .ok_or("no pane to open the app for")?,
        };
        let owner = self.model.owner_of(&from);
        let near = owner
            .as_deref()
            .and_then(|o| self.model.pane_of(o))
            .unwrap_or(from);
        let space = self
            .model
            .space_of(&near)
            .map(|s| s.id.clone())
            .ok_or("no space")?;
        let machine = self.machine_of(&space);
        self.require_document(machine.as_deref())?;
        let mut props = match a.get("props") {
            None | Some(Value::Null) => json!({}),
            Some(p @ Value::Object(_)) => p.clone(),
            Some(_) => return Err("app.open props is an object".into()),
        };
        props["app"] = json!(app);
        // One opened as a new tab each time (a link, a review the agent opens)
        // is no button's: no later open shows it again (`Model::find_app`).
        if reuse == Reuse::None {
            props["reuse"] = json!(reuse.as_str());
        }
        if let Some(owner) = &owner {
            props["origin"] = json!(crate::mirror::local(owner, machine.as_deref()));
        }
        if props.get("project").is_none()
            && let Some((machine, folder)) = self.pane_project(&near)
        {
            props["project"] = json!({ "folder": folder, "machine": machine });
        }
        let project = model::app_project(&props);
        let query = AppQuery {
            name: &name,
            app: &app,
            owner: owner.as_deref(),
            project: project.as_ref(),
            reuse,
        };
        self.focused_block = None;
        self.focused_pane = None;
        if let Some(pane) = self.model.find_app(&query) {
            self.model.update_app_props(&pane, &props);
            if let Some(copy) = self.copies.get(&pane).filter(|c| c.root.is_some()) {
                let mut update = props.clone();
                update["pane"] = json!(pane);
                mods::send_link_to(copy.id, update);
            }
            self.model.focus_pane(&pane);
            let tab = self.model.tab_of(&pane).map(|t| t.id.clone());
            let space = self.model.space_of(&pane).map(|s| s.id.clone());
            return Ok(json!({ "space": space, "tab": tab, "pane": pane, "reused": true }));
        }
        let title = Self::owned(a, "title")
            .or_else(|| registration.map(|r| r.reg.label.clone()))
            .unwrap_or_else(|| name.clone());
        let (tab, pane) = (
            self.model.fresh_id_on("tb", machine.as_deref()),
            self.model.fresh_id_on("p", machine.as_deref()),
        );
        self.model.add_tab(
            &space,
            Tab::with_pane(
                &tab,
                title.trim(),
                Node::block(pane.clone(), Content::Mod { name, props }),
            ),
        );
        self.model.active = Some(space.clone());
        Ok(json!({ "space": space, "tab": tab, "pane": pane, "reused": false }))
    }

    /// `app.beside`: an app tab (default: the selected one) moves into its
    /// agent's tab, right of the agent's pane. Its copy keeps running.
    pub(super) fn app_beside(&mut self, a: &Value) -> Result<Value, String> {
        let tab = Self::owned(a, "tab")
            .or_else(|| self.model.active_tab().map(|t| t.id.clone()))
            .ok_or("no tab")?;
        self.require_document(self.machine_of_node(&tab).as_deref())?;
        let pane = self.model.app_beside(&tab)?;
        self.focused_block = None;
        self.focused_pane = None;
        Ok(json!({ "pane": pane, "tab": self.model.tab_of(&pane).map(|t| t.id.clone()) }))
    }

    /// `app.apart`: an app pane beside its agent (default: the focused pane)
    /// moves back into a tab of its own after the agent's tab.
    pub(super) fn app_apart(&mut self, a: &Value) -> Result<Value, String> {
        let pane = Self::owned(a, "pane")
            .or_else(|| self.model.focused_pane())
            .ok_or("no pane")?;
        let machine = self.machine_of_node(&pane);
        self.require_document(machine.as_deref())?;
        let id = self.model.fresh_id_on("tb", machine.as_deref());
        let tab = self.model.app_apart(&pane, &id)?;
        self.focused_block = None;
        self.focused_pane = None;
        Ok(json!({ "pane": pane, "tab": tab }))
    }

    /// The app tabs opened for these terminals close with them.
    pub(super) fn close_owned(&mut self, gone: &[String]) {
        for tab in self.model.tabs_closing_with(gone) {
            self.model.remove_tab(&tab);
        }
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

    /// What `apps()` reads: every registered app, and for each pane the ones
    /// available for the agent it works for (`Model::owner_of`: its project
    /// and terminal; without one the pane's own), as `[mod, app, tab]`. `tab`:
    /// the open tab its button shows again (`reuse`), else null.
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
        // Panes working for one agent share its answer.
        let mut by_near: HashMap<String, Value> = HashMap::new();
        let mut available = serde_json::Map::new();
        for pane in panes {
            let owner = self.model.owner_of(&pane);
            let near = owner
                .as_deref()
                .and_then(|o| self.model.pane_of(o))
                .unwrap_or_else(|| pane.clone());
            if let Some(ids) = by_near.get(&near) {
                available.insert(pane, ids.clone());
                continue;
            }
            let project = self.pane_project(&near);
            let probe = match (&project, looks) {
                (Some((machine, folder)), true) => {
                    self.folder_probe(machine.clone(), folder.clone(), &files)
                }
                _ => None,
            };
            let machine = project
                .as_ref()
                .map(|(m, _)| m.clone())
                .unwrap_or_else(|| self.machine_of_node(&near));
            let project =
                project.map(|(machine, folder)| json!({ "folder": folder, "machine": machine }));
            let record = self.model.address_of(&near).and_then(|a| self.live.get(&a));
            let place = Place {
                local: machine.as_deref().is_none_or(|m| locals.contains(m)),
                labels: record.and_then(|r| r.get("labels")).unwrap_or(&Value::Null),
                foreground_pid: record
                    .and_then(|r| r.pointer("/foreground/pid"))
                    .and_then(Value::as_u64),
                probe: probe.as_ref(),
            };
            let ids = Value::Array(
                all.iter()
                    .filter(|a| apps::available(a, &place))
                    .map(|a| {
                        let open = self.model.find_app(&AppQuery {
                            name: &a.name,
                            app: a.id(),
                            owner: owner.as_deref(),
                            project: project.as_ref(),
                            reuse: a.reg.reuse,
                        });
                        let tab = open
                            .and_then(|p| self.model.tab_of(&p))
                            .map(|t| t.id.clone());
                        json!([a.name, a.id(), tab])
                    })
                    .collect(),
            );
            by_near.insert(near, ids.clone());
            available.insert(pane, ids);
        }
        json!({ "apps": all.iter().map(|a| a.json(false)).collect::<Vec<_>>(), "available": available })
    }

    /// Opens a link in an app. A web page an open app was opened on (its
    /// `props.url`, such as a Plannotator review) shows that app. Else the
    /// app of the first registration that takes it opens it (`app.open`) for
    /// the agent the terminal it came from works for, else the focused
    /// pane's: in a new tab, or in the open one its registration's `reuse`
    /// names when its link rule says `reuse`. A file or folder that `has`
    /// rules ask about is looked at first, off the UI thread: the link comes
    /// back with `probed`, the files found there. False: no app takes it.
    pub(super) fn open_link_in_app(
        &mut self,
        link: &Value,
        probed: Option<Value>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if let Some(pane) = link["url"]
            .as_str()
            .and_then(apps::page)
            .and_then(|page| self.model.app_on_page(&page))
        {
            let reply = self.run_as("pane.focus", json!({ "pane": pane }), false, window, cx);
            return reply.get("error").is_none();
        }
        let all = self.registered_apps();
        if all.is_empty() {
            return false;
        }
        let machine = link["machine"].as_str().map(str::to_owned);
        let local = machine
            .as_deref()
            .is_none_or(|m| apps::local_machines().contains(m));
        let probe: Option<Probe> = match probed {
            Some(p) => serde_json::from_value::<Vec<String>>(p)
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
                    mods::request(Request::OpenLink {
                        link,
                        system: false,
                    });
                });
                return true;
            }
            None => None,
        };
        let Some((app, rule)) = all
            .iter()
            .find_map(|a| apps::link_rule(a, link, local, probe.as_ref()).map(|r| (a, r)))
        else {
            return false;
        };
        // For the agent the link's terminal works for, else the focused pane's.
        let from = link["terminal"]
            .as_str()
            .filter(|t| self.model.pane_of(t).is_some());
        let reuse = if rule.reuse {
            app.reg.reuse
        } else {
            Reuse::None
        };
        let args = json!({ "mod": app.name, "app": app.id(), "for": from, "reuse": reuse.as_str(), "props": { "link": link } });
        let reply = self.run_as("app.open", args, false, window, cx);
        if let Some(error) = reply.get("error").and_then(Value::as_str) {
            tracing::warn!("cannot open the link in {}: {error}", app.reg.label);
            return false;
        }
        true
    }
}
