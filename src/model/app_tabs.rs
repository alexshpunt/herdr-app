//! Apps opened as tabs (`app.open`): a tab whose only pane is a mod, opened
//! for an agent (its `origin` prop) or for a project. Which agent a pane
//! works for, which open app a later open shows again, and moving an app
//! beside its agent and back into a tab of its own.

use super::*;
use crate::apps::Reuse;

/// An app pane: a mod pane opened with `app.open`, its props naming its
/// registration (`app`). Returns (mod, registration, props).
pub fn app_of(n: &Node) -> Option<(&str, &str, &Value)> {
    match n.content() {
        Some(Content::Mod { name, props }) => Some((name, props.get("app")?.as_str()?, props)),
        _ => None,
    }
}

/// The project an app pane works on, as reuse compares it: the folder of the
/// folder link it was opened for (a Unity project), else its `project` prop.
pub fn app_project(props: &Value) -> Option<Value> {
    let link = &props["link"];
    if link["kind"] == "folder" && link["path"].is_string() {
        return Some(json!({ "folder": link["path"], "machine": link["machine"] }));
    }
    props.get("project").filter(|p| !p.is_null()).cloned()
}

/// What `app.open` asks for: an app of a mod for an owner (an agent's full
/// address, or none) on a project, and how it reuses one that is open.
pub struct AppQuery<'a> {
    pub name: &'a str,
    pub app: &'a str,
    pub owner: Option<&'a str>,
    pub project: Option<&'a Value>,
    pub reuse: Reuse,
}

impl Model {
    /// The agent a pane works for: its own terminal's agent; else the agent
    /// an app pane was opened for; else the agent its tab was opened for;
    /// else the agent last focused in its tab. None: no agent.
    pub fn owner_of(&self, pane: &str) -> Option<String> {
        let space = self.space_of(pane)?;
        let tab = space.tabs.iter().find(|t| t.root.find(pane).is_some())?;
        let alive = |a: &String| self.status(a).is_some();
        let agent = |p: &str| self.address_of(p).filter(alive);
        if let Some(a) = agent(pane) {
            return Some(a);
        }
        let own = match tab.root.find(pane).and_then(Node::content) {
            Some(Content::Mod { props, .. }) => origin_address(space, props).filter(alive),
            _ => None,
        };
        own.or_else(|| tab_origin(space, tab).filter(alive))
            .or_else(|| {
                tab.focused
                    .iter()
                    .chain(tab.before.iter().rev())
                    .find_map(|p| agent(p))
            })
    }

    /// The open app pane a new open of `q` shows instead: the same mod and
    /// registration for the same owner, and with `Reuse::Project` (or no
    /// owner) on the same project. One opened with `Reuse::None` (its
    /// `reuse` prop) is never shown again.
    pub fn find_app(&self, q: &AppQuery) -> Option<String> {
        if q.reuse == Reuse::None {
            return None;
        }
        let by_project = q.reuse == Reuse::Project || q.owner.is_none();
        self.spaces
            .iter()
            .flat_map(|s| {
                s.tabs
                    .iter()
                    .flat_map(move |t| t.root.panes().into_iter().map(move |n| (s, n)))
            })
            .find(|(s, n)| {
                app_of(n).is_some_and(|(name, app, props)| {
                    name == q.name
                        && app == q.app
                        && props["reuse"] != Reuse::None.as_str()
                        && origin_address(s, props).as_deref() == q.owner
                        && (!by_project || app_project(props).as_ref() == q.project)
                })
            })
            .map(|(_, n)| n.id.clone())
    }

    /// A mod pane opened on web page `page` (its `props.url`, as `apps::page` reads it).
    pub fn app_on_page(&self, page: &str) -> Option<String> {
        self.tabs()
            .flat_map(|c| c.root.panes())
            .find(|n| match n.content() {
                Some(Content::Mod { props, .. }) => {
                    props["url"].as_str().and_then(crate::apps::page).as_deref() == Some(page)
                }
                _ => false,
            })
            .map(|n| n.id.clone())
    }

    /// An app opened again: its stored props take the new ones (key by key),
    /// so a restart opens what it shows now.
    pub fn update_app_props(&mut self, pane: &str, update: &Value) -> bool {
        let Some(node) = self.tab_of_mut(pane).and_then(|t| t.root.find_mut(pane)) else {
            return false;
        };
        let Kind::Block {
            content: Content::Mod { props, .. },
        } = &mut node.kind
        else {
            return false;
        };
        match (props.as_object_mut(), update.as_object()) {
            (Some(old), Some(new)) => old.extend(new.clone()),
            _ if !update.is_null() => *props = update.clone(),
            _ => {}
        }
        true
    }

    /// The tabs opened for an agent (`tab_origin`), in every space.
    pub fn owned_tabs(&self, owner: &str) -> Vec<String> {
        self.spaces
            .iter()
            .flat_map(|s| {
                s.tabs
                    .iter()
                    .filter(move |t| tab_origin(s, t).as_deref() == Some(owner))
            })
            .map(|t| t.id.clone())
            .collect()
    }

    /// The tabs that close with these terminals: the app tabs opened for
    /// them. One someone added a terminal to stays.
    pub fn tabs_closing_with(&self, gone: &[String]) -> Vec<String> {
        gone.iter()
            .flat_map(|a| self.owned_tabs(a))
            .filter(|t| self.tab(t).is_some_and(|t| t.root.terminals().is_empty()))
            .collect()
    }

    /// Moves an app tab's pane into its agent's tab, right of the agent's
    /// pane, and focuses it. The tab's name goes with it (the pane's
    /// `title`), for `app_apart`. Returns the pane.
    pub fn app_beside(&mut self, tab: &str) -> Result<String, String> {
        let space = self
            .space_of(tab)
            .ok_or_else(|| format!("no tab {tab:?}"))?;
        let t = space.tab(tab).ok_or_else(|| format!("no tab {tab:?}"))?;
        let [pane] = t.root.panes()[..] else {
            return Err(format!("tab {tab:?} holds more than one app"));
        };
        let Some(Content::Mod { props, .. }) = pane.content() else {
            return Err(format!("tab {tab:?} is no app"));
        };
        let owner = origin_address(space, props)
            .ok_or_else(|| format!("tab {tab:?} was not opened for an agent"))?;
        let target = space
            .tabs
            .iter()
            .flat_map(|t| t.root.terminals())
            .find(|n| n.terminal() == Some(owner.as_str()))
            .map(|n| n.id.clone())
            .ok_or_else(|| format!("its agent {owner} has no pane in this space"))?;
        let (space_id, pane_id, name) = (space.id.clone(), pane.id.clone(), t.name.clone());
        let p = self.space_mut(&space_id).unwrap();
        let i = p.tabs.iter().position(|c| c.id == tab).unwrap();
        let mut node = p.tabs.remove(i).root.remove(&pane_id).unwrap();
        if p.active.as_deref() == Some(tab) {
            p.active = None;
        }
        node.size = None;
        node.title = (!name.is_empty()).then_some(name);
        self.split_with(&target, Axis::Row, node);
        self.focus_pane(&pane_id);
        Ok(pane_id)
    }

    /// Moves an app pane out of the tab it shares into a tab of its own
    /// (`id`), after its agent's tab, and shows it. Returns the tab.
    pub fn app_apart(&mut self, pane: &str, id: &str) -> Result<String, String> {
        let space = self
            .space_of(pane)
            .map(|s| s.id.clone())
            .ok_or_else(|| format!("no pane {pane:?}"))?;
        let t = self.tab_of(pane).unwrap();
        if !matches!(
            t.root.find(pane).and_then(Node::content),
            Some(Content::Mod { .. })
        ) {
            return Err(format!("pane {pane:?} is no app"));
        }
        if t.root.panes().len() == 1 {
            return Err(format!("pane {pane:?} has a tab of its own"));
        }
        let mut node = self.take_pane(pane).unwrap();
        node.size = None;
        let name = node.title.take().unwrap_or_default();
        self.add_tab(&space, Tab::with_pane(id, &name, node));
        self.active = Some(space);
        Ok(id.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(id: &str, name: &str, app: &str, props: Value) -> Node {
        let mut props = props;
        props["app"] = json!(app);
        Node::block(
            id,
            Content::Mod {
                name: name.into(),
                props,
            },
        )
    }

    /// Agents t1 (tab a, pane x1) and t2 (tab b, pane x2) in space s.
    fn two_agents() -> Model {
        let mut m = Model::default();
        m.add_space("s", "", "/r", Tab::new("a", "", "x1", "t1"));
        m.add_tab("s", Tab::new("b", "", "x2", "t2"));
        for t in ["t1", "t2"] {
            m.set_word(t, Some("idle".into()), None, true);
        }
        m
    }

    fn tab_ids(m: &Model) -> Vec<&str> {
        m.space("s")
            .unwrap()
            .tabs
            .iter()
            .map(|t| t.id.as_str())
            .collect()
    }

    #[test]
    fn a_pane_works_for_its_agent_its_tabs_agent_or_the_agent_last_focused_there() {
        let mut m = two_agents();
        m.add_tab(
            "s",
            Tab::with_pane(
                "files",
                "Files",
                app("v", "vscode", "files", json!({ "origin": "t1" })),
            ),
        );
        assert_eq!(m.owner_of("x1").as_deref(), Some("t1"));
        assert_eq!(m.owner_of("v").as_deref(), Some("t1"));
        // A shell split beside an agent works for the agent focused there last.
        assert!(m.split("x2", Axis::Row, "x3", "t3"));
        assert_eq!(m.owner_of("x3").as_deref(), Some("t2"));
        // A tab without an agent: nobody's.
        m.add_tab("s", Tab::new("c", "", "x4", "t4"));
        assert_eq!(m.owner_of("x4"), None);
        // An origin that is no agent (gone) doesn't count.
        m.add_tab(
            "s",
            Tab::with_pane(
                "old",
                "",
                app("o", "fork", "diff", json!({ "origin": "t9" })),
            ),
        );
        assert_eq!(m.owner_of("o"), None);
    }

    #[test]
    fn an_open_app_is_reused_per_agent_or_per_project_and_never_with_none() {
        let mut m = two_agents();
        let p1 = json!({ "folder": "/r", "machine": null });
        let p2 = json!({ "folder": "/q", "machine": null });
        m.add_tab(
            "s",
            Tab::with_pane(
                "files",
                "Files",
                app(
                    "v",
                    "vscode",
                    "files",
                    json!({ "origin": "t1", "project": p1 }),
                ),
            ),
        );
        m.add_tab(
            "s",
            Tab::with_pane(
                "diff",
                "Diff",
                app(
                    "f",
                    "fork",
                    "diff",
                    json!({ "origin": "t1", "project": p1 }),
                ),
            ),
        );
        m.add_tab(
            "s",
            Tab::with_pane(
                "unity",
                "Unity",
                app("u", "unity", "unity", json!({ "project": p1 })),
            ),
        );
        let q = |name, app, owner, project, reuse| AppQuery {
            name,
            app,
            owner,
            project,
            reuse,
        };
        // Per agent: whatever project.
        assert_eq!(
            m.find_app(&q("vscode", "files", Some("t1"), Some(&p2), Reuse::Agent))
                .as_deref(),
            Some("v")
        );
        assert_eq!(
            m.find_app(&q("vscode", "files", Some("t2"), Some(&p1), Reuse::Agent)),
            None
        );
        // Per project: the same agent and project.
        assert_eq!(
            m.find_app(&q("fork", "diff", Some("t1"), Some(&p1), Reuse::Project))
                .as_deref(),
            Some("f")
        );
        assert_eq!(
            m.find_app(&q("fork", "diff", Some("t1"), Some(&p2), Reuse::Project)),
            None
        );
        // Nobody's: per project.
        assert_eq!(
            m.find_app(&q("unity", "unity", None, Some(&p1), Reuse::Agent))
                .as_deref(),
            Some("u")
        );
        assert_eq!(
            m.find_app(&q("unity", "unity", None, Some(&p2), Reuse::Agent)),
            None
        );
        // A tab a link opened as a new one (`reuse: "none"`) is no button's.
        m.add_tab(
            "s",
            Tab::with_pane(
                "pr",
                "GitHub",
                app(
                    "w",
                    "project-web",
                    "github",
                    json!({ "origin": "t1", "project": p1, "reuse": "none", "link": { "kind": "url", "url": "https://github.com/a/b/pull/1" } }),
                ),
            ),
        );
        assert_eq!(
            m.find_app(&q(
                "project-web",
                "github",
                Some("t1"),
                Some(&p1),
                Reuse::Project
            )),
            None
        );
        assert_eq!(
            m.find_app(&q("vscode", "files", Some("t1"), Some(&p1), Reuse::None)),
            None
        );
    }

    #[test]
    fn a_folder_link_names_the_project_an_app_works_on() {
        let props = json!({ "project": { "folder": "/r", "machine": null }, "link": { "kind": "folder", "path": "/r/Game", "machine": "vps" } });
        assert_eq!(
            app_project(&props),
            Some(json!({ "folder": "/r/Game", "machine": "vps" }))
        );
        let file = json!({ "project": { "folder": "/r", "machine": null }, "link": { "kind": "file", "path": "/r/a.rs" } });
        assert_eq!(
            app_project(&file),
            Some(json!({ "folder": "/r", "machine": null }))
        );
        assert_eq!(app_project(&json!({})), None);
    }

    #[test]
    fn an_app_opened_again_keeps_its_props_and_takes_the_new_ones() {
        let mut m = two_agents();
        m.add_tab(
            "s",
            Tab::with_pane(
                "r",
                "",
                app(
                    "p",
                    "plannotator-browser",
                    "review",
                    json!({ "origin": "t1" }),
                ),
            ),
        );
        assert!(m.update_app_props(
            "p",
            &json!({ "url": "http://localhost:19432/", "review": "r1" })
        ));
        let Some(Content::Mod { props, .. }) =
            m.tab("r").unwrap().root.find("p").unwrap().content()
        else {
            panic!()
        };
        assert_eq!(
            props,
            &json!({ "origin": "t1", "app": "review", "url": "http://localhost:19432/", "review": "r1" })
        );
        assert_eq!(
            m.app_on_page("http://localhost:19432").as_deref(),
            Some("p")
        );
        assert_eq!(m.app_on_page("http://localhost:19500"), None);
        assert!(
            !m.update_app_props("x1", &json!({})),
            "a terminal pane has no props"
        );
    }

    #[test]
    fn an_app_moves_beside_its_agent_and_back_after_its_tab() {
        let mut m = two_agents();
        m.add_tab(
            "s",
            Tab::with_pane(
                "files",
                "Files",
                app("v", "vscode", "files", json!({ "origin": "t1" })),
            ),
        );
        assert_eq!(tab_ids(&m), ["a", "files", "b"]);
        assert_eq!(m.owned_tabs("t1"), ["files"]);

        assert_eq!(m.app_beside("files").as_deref(), Ok("v"));
        assert_eq!(tab_ids(&m), ["a", "b"]);
        let a = m.tab("a").unwrap();
        assert_eq!(
            a.root
                .panes()
                .iter()
                .map(|n| n.id.as_str())
                .collect::<Vec<_>>(),
            ["x1", "v"]
        );
        assert_eq!(m.focused_pane().as_deref(), Some("v"));
        // Beside its agent it is still the agent's, and the agent's tab is nobody's.
        assert_eq!(m.owner_of("v").as_deref(), Some("t1"));
        assert_eq!(tab_origin(m.space("s").unwrap(), m.tab("a").unwrap()), None);
        assert!(m.owned_tabs("t1").is_empty());
        assert!(m.app_beside("a").is_err(), "an agent's tab is no app tab");

        assert_eq!(m.app_apart("v", "files2").as_deref(), Ok("files2"));
        assert_eq!(tab_ids(&m), ["a", "files2", "b"]);
        assert_eq!(m.tab("files2").unwrap().name, "Files");
        assert_eq!(m.tab("a").unwrap().root.panes().len(), 1);
        assert_eq!(m.focused_pane().as_deref(), Some("v"));
        assert!(
            m.app_apart("v", "again").is_err(),
            "it has a tab of its own"
        );
        assert!(m.app_apart("x1", "again").is_err(), "a terminal is no app");
    }

    #[test]
    fn a_new_tab_opened_from_an_agents_tabs_goes_after_all_of_them() {
        let mut m = two_agents();
        m.add_tab(
            "s",
            Tab::with_pane(
                "files",
                "Files",
                app("v", "vscode", "files", json!({ "origin": "t1" })),
            ),
        );
        m.add_tab(
            "s",
            Tab::with_pane(
                "diff",
                "Diff",
                app("f", "fork", "diff", json!({ "origin": "t1" })),
            ),
        );
        m.select_tab("files");
        m.add_tab("s", Tab::new("c", "", "x3", "t3"));
        assert_eq!(tab_ids(&m), ["a", "files", "diff", "c", "b"]);
        m.select_tab("a");
        m.add_tab("s", Tab::new("d", "", "x4", "t4"));
        assert_eq!(tab_ids(&m), ["a", "files", "diff", "d", "c", "b"]);
    }

    #[test]
    fn an_agents_app_tabs_close_with_it_unless_someone_added_a_terminal() {
        let mut m = two_agents();
        m.add_tab(
            "s",
            Tab::with_pane(
                "files",
                "Files",
                app("v", "vscode", "files", json!({ "origin": "t1" })),
            ),
        );
        m.add_tab(
            "s",
            Tab::with_pane(
                "diff",
                "Diff",
                app("f", "fork", "diff", json!({ "origin": "t1" })),
            ),
        );
        m.add_tab(
            "s",
            Tab::with_pane(
                "other",
                "Diff",
                app("o", "fork", "diff", json!({ "origin": "t2" })),
            ),
        );
        assert_eq!(m.tabs_closing_with(&["t1".into()]), ["files", "diff"]);
        assert!(m.split("f", Axis::Row, "x3", "t3"));
        assert_eq!(m.tabs_closing_with(&["t1".into()]), ["files"]);
        assert!(m.tabs_closing_with(&["t9".into()]).is_empty());
    }

    #[test]
    fn an_app_of_nobody_or_of_an_agent_elsewhere_stays_in_its_tab() {
        let mut m = two_agents();
        m.add_tab(
            "s",
            Tab::with_pane("u", "Unity", app("u", "unity", "unity", json!({}))),
        );
        assert!(m.app_beside("u").is_err());
        m.add_space(
            "s2",
            "",
            "/q",
            Tab::with_pane(
                "far",
                "",
                app("f", "fork", "diff", json!({ "origin": "t1" })),
            ),
        );
        assert!(
            m.app_beside("far").is_err(),
            "its agent is in another space"
        );
    }
}
