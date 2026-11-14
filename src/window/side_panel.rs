//! The side panel: a `{ "side_panel": true }` block stacks the sections mods
//! register with `"side_panel": { "title", "order" }` in their mod.json, in
//! one scrolling column. Each section is one copy of its mod, slot
//! `<block>/<mod>`, as tall as its content, under a heading drawn like the
//! sidebar's list headings.

use super::*;
use gpui_base::{Scrollbar, ScrollbarMode};

/// The node the layout shows and hides as the side panel (its toggle).
pub(super) const PANEL: &str = "side-panel";

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
                div()
                    .id(SharedString::from(selector.clone()))
                    .debug_selector(move || selector)
                    .w_full()
                    .flex_none()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .h(settings::z(31.0))
                            .pl(settings::z(16.0))
                            .pr(settings::z(10.0))
                            .flex()
                            .items_center()
                            .text_size(settings::z(11.5))
                            .text_color(c("dim"))
                            .child(title),
                    )
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .flex_col()
                            .child(self.render_slot(&section_slot(&n.id, &name), cx)),
                    )
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
                    .gap(settings::z(14.0))
                    .pb(settings::z(14.0))
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
