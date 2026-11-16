//! The side panel: a `{ "side_panel": true }` block stacks the sections mods
//! register with `"side_panel": { "title", "order" }` in their mod.json, in
//! one scrolling column. Each section is one copy of its mod, slot
//! `<block>/<mod>`, as tall as its content, under a heading drawn like the
//! sidebar's list headings. Clicking a heading folds its section to the
//! heading; folds are kept in `side-panel.json` across starts.

use super::*;
use gpui_base::{Scrollbar, ScrollbarMode};

/// The node the layout shows and hides as the side panel (its toggle).
pub(super) const PANEL: &str = "side-panel";

fn folds_path() -> PathBuf {
    file("side-panel.json")
}

/// The sections folded to their headings, by mod name.
pub(super) fn folded_sections() -> HashSet<String> {
    std::fs::read_to_string(folds_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("folded").cloned())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// A section's slot: one copy per side panel block and mod.
pub(super) fn section_slot(block: &str, name: &str) -> String {
    format!("{block}/{name}")
}

impl AppWindow {
    /// The mods registered as side panel sections, in order: (mod, heading).
    pub(super) fn side_sections(&self) -> Vec<(String, String)> {
        let mut found: Vec<(i32, String, String)> = self
            .folders
            .values()
            .filter_map(|f| {
                let section = f.hint.side_panel.as_ref()?;
                if !section.enabled(&self.person) { return None; }
                let title = section
                    .title
                    .clone()
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| f.id.clone());
                Some((section.order, title, f.id.clone()))
            })
            .collect();
        found.sort();
        found
            .into_iter()
            .map(|(_, title, name)| (name, title))
            .collect()
    }

    /// The section copies of one side panel block: (slot, instance).
    pub(super) fn side_slots(&self, block: &str) -> Vec<(String, Instance)> {
        self.side_sections()
            .into_iter()
            .map(|(name, _)| {
                (
                    section_slot(block, &name),
                    Instance {
                        name,
                        props: Value::Null,
                    },
                )
            })
            .collect()
    }

    /// A section's copy sizes to its content, like a popup's.
    pub(super) fn is_section(&self, slot: &str) -> bool {
        slot.split_once('/').is_some_and(|(block, _)| {
            self.chrome
                .find(block)
                .is_some_and(|n| matches!(n.content(), Some(Content::SidePanel { .. })))
        })
    }

    /// Folds a section to its heading or shows it again. Its copy keeps running.
    pub(super) fn toggle_side_section(&mut self, name: &str, cx: &mut Context<Self>) {
        if !self.side_folded.remove(name) {
            self.side_folded.insert(name.to_string());
        }
        let mut folded: Vec<&String> = self.side_folded.iter().collect();
        folded.sort();
        if let Ok(s) = serde_json::to_string_pretty(&json!({ "folded": folded })) {
            let _ = crate::persist::write_atomic(&folds_path(), s + "\n");
        }
        cx.notify();
    }

    pub(super) fn render_side_panel(&self, n: &Node, cx: &mut Context<Self>) -> AnyElement {
        let handle = self
            .side_scroll
            .borrow_mut()
            .entry(n.id.clone())
            .or_default()
            .clone();
        let sections: Vec<AnyElement> = self
            .side_sections()
            .into_iter()
            .map(|(name, title)| {
                let selector = format!("side-section-{name}");
                let heading = format!("side-section-heading-{name}");
                let folded = self.side_folded.contains(&name);
                let toggle = name.clone();
                div()
                    .id(SharedString::from(selector.clone()))
                    .debug_selector(move || selector)
                    .w_full()
                    .flex_none()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .id(SharedString::from(heading.clone()))
                            .debug_selector(move || heading)
                            .cursor_pointer()
                            .gap(settings::z(5.0))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.toggle_side_section(&toggle, cx)
                            }))
                            .h(settings::z(31.0))
                            .pl(settings::z(16.0))
                            .pr(settings::z(10.0))
                            .flex()
                            .items_center()
                            .text_size(settings::z(11.5))
                            .text_color(c("dim"))
                            .child(if folded { "▸" } else { "▾" })
                            .child(title),
                    )
                    // Only an open section is followed by a gap; folded headings stack tightly.
                    .when(!folded, |d| {
                        d.mb(settings::z(14.0)).child(
                            div()
                                .w_full()
                                .flex()
                                .flex_col()
                                .child(self.render_slot(&section_slot(&n.id, &name), cx)),
                        )
                    })
                    .into_any_element()
            })
            .collect();
        let list = SharedString::from(format!("side-panel-{}", n.id));
        let selector = list.to_string();
        div()
            .size_full()
            .relative()
            .child(
                div()
                    .id(list)
                    .debug_selector(move || selector)
                    .absolute()
                    .inset_0()
                    .overflow_y_scroll()
                    .track_scroll(&handle)
                    .flex()
                    .flex_col()
                    .children(sections),
            )
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .child(Scrollbar::vertical(&handle).mode(ScrollbarMode::Always)),
            )
            .into_any_element()
    }
}
