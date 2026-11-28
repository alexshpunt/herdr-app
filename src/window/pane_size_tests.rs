#[test]
fn a_pane_hidden_before_first_paint_still_attaches() {
    in_own_process("unpainted_hidden_pane");
}

#[gpui::test]
fn unpainted_hidden_pane(cx: &mut gpui::TestAppContext) {
    if !running_alone("unpainted_hidden_pane") { return; }
    let plain = serde_json::json!({"id": "context", "type": "block", "content": {"tab": "active"}});
    let (view, cx) = open_window(cx, "size-probe", "export default () => null;", plain);
    view.update_in(cx, |this, window, cx| {
        this.folders.retain(|id, _| id == "size-probe");
        this.model = crate::model::Model::default();
        let mut tab = super::Tab::new("tab", "", "a", "probe-a");
        tab.root.split("a", super::Axis::Row, crate::model::pane("b", "probe-b"), "split".into());
        this.model.add_space("space", "test", "/", tab);
        this.sync(window, cx);
        assert!(!this.terms["b"].view.read(cx).lost);
        this.model.tab_mut("tab").unwrap().zoomed = Some("a".into());
        this.sync(window, cx);
    });
    cx.run_until_parked();
    cx.executor().advance_clock(std::time::Duration::from_millis(100));
    cx.run_until_parked();
    assert!(view.update(cx, |this, cx| this.terms["b"].view.read(cx).lost),
        "the hidden pane must attempt to attach without ever being painted");
}

#[test]
fn a_covered_pane_attaches_without_painting() {
    in_own_process("covered_pane_deadline");
}

#[gpui::test]
fn covered_pane_deadline(cx: &mut gpui::TestAppContext) {
    if !running_alone("covered_pane_deadline") { return; }
    let plain = serde_json::json!({"id": "context", "type": "block", "content": {"tab": "active"}});
    let (view, cx) = open_window(cx, "size-probe", "export default () => null;", plain);
    view.update_in(cx, |this, window, cx| {
        this.folders.retain(|id, _| id == "size-probe");
        this.model = crate::model::Model::default();
        this.model.add_space("space", "test", "/", super::Tab::new("tab", "", "a", "probe-a"));
        this.sync(window, cx);
        this.live.insert("replacement".into(), serde_json::json!({"state": "live"}));
        this.swapped.insert("a".into(), "replacement".into());
        this.sync(window, cx);
    });
    cx.run_until_parked();
    cx.executor().advance_clock(std::time::Duration::from_millis(100));
    cx.run_until_parked();
    assert!(view.update(cx, |this, cx| this.terms["a"].view.read(cx).lost),
        "a covered original pane must still attempt to attach");
}

#[test]
fn an_agent_only_layout_fits_its_pane_before_attaching() {
    in_own_process("agent_only_first_fit");
}

#[gpui::test]
fn agent_only_first_fit(cx: &mut gpui::TestAppContext) {
    if !running_alone("agent_only_first_fit") { return; }
    let layout = serde_json::json!({"id": "agent", "type": "block", "content": {"agent": "focused"}});
    let (view, cx) = open_window(cx, "size-probe", "export default () => null;", layout);
    view.update_in(cx, |this, window, cx| {
        this.folders.retain(|id, _| id == "size-probe");
        this.model = crate::model::Model::default();
        this.model.add_space("space", "test", "/", super::Tab::new("tab", "", "a", "probe-a"));
        this.live.insert("probe-a".into(), serde_json::json!({"state": "live"}));
        this.agent = Some("probe-a".into());
        this.sync(window, cx);
        assert!(!this.terms["a"].view.read(cx).lost);
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
    view.update(cx, |this, cx| {
        let terminal = this.terms["a"].view.read(cx);
        assert!(terminal.lost, "the drawn agent pane must attach before the deadline");
        assert_ne!(terminal.dimensions(), (120, 40), "replay must use agent-block layout");
    });
}

#[test]
fn initial_pane_size_matches_the_rendered_terminal() {
    in_own_process("initial_pane_size");
}

#[gpui::test]
fn initial_pane_size(cx: &mut gpui::TestAppContext) {
    use serde_json::json;
    use super::Axis::{Column, Row};
    if !running_alone("initial_pane_size") { return; }
    let plain = json!({"id": "context", "type": "block", "content": {"tab": "active"}});
    let framed = json!({"id": "context", "type": "block", "padding": [8, 10],
        "border": {"width": 1, "color": "border"},
        "content": {"tab": "active", "pane": {
            "gap": 6, "border": {"width": 2, "color": "border"},
            "header": {"height": 23, "content": {"mod": "size-probe"}}
        }}
    });
    let main: serde_json::Value = serde_json::from_str(include_str!("../../defaults/layouts/main.json")).unwrap();
    let (view, cx) = open_window(cx, "size-probe", "export default () => null;", plain.clone());
    for (label, layout, steps) in [
        ("lone", plain.clone(), vec![]),
        ("right", plain.clone(), vec![Row]),
        ("down", plain.clone(), vec![Column]),
        ("nested", plain.clone(), vec![Row, Column, Row]),
        ("constrained-max", plain.clone(), vec![Row]),
        ("constrained-min", plain.clone(), vec![Row]),
        ("constrained-mixed", plain.clone(), vec![Row, Row]),
        ("thick-border", json!({"id": "context", "type": "block", "padding": [8, 10],
            "border": {"width": 20, "color": "border"}, "content": {"tab": "active"}}), vec![Row]),
        ("headers-padding", framed, vec![Row, Column]),
        ("main-right", main.clone(), vec![Row]),
        ("main-down", main.clone(), vec![Column]),
        ("main-nested", main, vec![Row, Column, Row]),
    ] {
        let mut root = crate::model::pane("a", "probe-a");
        let mut target = "a".to_owned();
        for (i, &axis) in steps.iter().enumerate().take(steps.len().saturating_sub(1)) {
            let next = format!("p{i}");
            root.split(&target, axis, crate::model::pane(&next, &format!("probe-{next}")), format!("s{i}"));
            target = next;
        }
        view.update_in(cx, |this, window, cx| {
            this.folders.retain(|id, _| id == "size-probe");
            this.chrome = serde_json::from_value(layout).unwrap();
            this.bounds.borrow_mut().clear();
            this.model = crate::model::Model::default();
            let mut tab = super::Tab::new("tab", "", "a", "probe-a");
            tab.root = root.clone();
            tab.focus(&target);
            this.model.add_space("space", "test", "/", tab);
            this.sync(window, cx);
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if let Some(&axis) = steps.last() {
            root.split(&target, axis, crate::model::pane("new", "probe-new"), "last".into());
            target = "new".into();
        }
        match label {
            "constrained-max" => root.find_mut("a").unwrap().max = Some(100.0),
            "constrained-min" => root.find_mut("a").unwrap().min = Some(1000.0),
            "constrained-mixed" => {
                root.find_mut("a").unwrap().min = Some(1100.0);
                root.find_mut("p0").unwrap().max = Some(100.0);
            }
            _ => {}
        }
        let predicted = view.update_in(cx, |this, window, _| this.initial_size(&root, &target, window)).expect(label);
        view.update_in(cx, |this, window, cx| {
            let tab = &mut this.model.spaces[0].tabs[0];
            tab.root = root.clone();
            tab.focus(&target);
            this.sync(window, cx);
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let actual = view.update(cx, |this, cx| this.terms[&target].view.read(cx).dimensions());
        let delta = (predicted.0.abs_diff(actual.0), predicted.1.abs_diff(actual.1));
        eprintln!("{label}: initial {predicted:?}, rendered {actual:?}, delta {delta:?} cells");
        assert_eq!(predicted, actual, "{label}: initial size must match the rendered grid exactly");
    }
}

#[test]
fn hidden_tabs_follow_the_window() {
    in_own_process("hidden_tabs_follow");
}

#[gpui::test]
fn hidden_tabs_follow(cx: &mut gpui::TestAppContext) {
    use gpui::{px, size};
    if !running_alone("hidden_tabs_follow") { return; }
    let main: serde_json::Value = serde_json::from_str(include_str!("../../defaults/layouts/main.json")).unwrap();
    let (view, cx) = open_window(cx, "size-probe", "export default () => null;", main);
    // Tab "a" has two panes side by side; tab "b" is the one shown.
    let mut root = crate::model::pane("a", "probe-a");
    root.split("a", super::Axis::Row, crate::model::pane("a2", "probe-a2"), "s".into());
    view.update_in(cx, |this, window, cx| {
        this.folders.retain(|id, _| id == "size-probe");
        this.model = crate::model::Model::default();
        let mut tab = super::Tab::new("ta", "", "a", "probe-a");
        tab.root = root;
        tab.focus("a2");
        this.model.add_space("space", "test", "/", tab);
        this.model.add_tab("space", super::Tab::new("tb", "", "b", "probe-b"));
        this.sync(window, cx);
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let dims = |cx: &mut gpui::VisualTestContext| view.update(cx, |this, cx| ["a", "a2"].map(|p| this.terms[p].view.read(cx).dimensions()));
    let before = dims(cx);
    cx.simulate_resize(size(px(1400.0), px(900.0)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    // The first tick after a change waits for the window to settle; the second sizes them.
    view.update_in(cx, |this, window, cx| this.fit_hidden_tabs(window, cx));
    assert_eq!(dims(cx), before, "a tick right after a change must leave hidden tabs alone");
    view.update_in(cx, |this, window, cx| this.fit_hidden_tabs(window, cx));
    let fitted = dims(cx);
    eprintln!("hidden tab: {before:?} before the window grew, {fitted:?} once it settled");
    assert_ne!(fitted, before, "a settled window must size the hidden tab's terminals");
    // Shown, the panes draw with the size they were given: nothing changes.
    view.update_in(cx, |this, window, cx| {
        this.model.select_tab("ta");
        this.sync(window, cx);
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(dims(cx), fitted, "hidden tabs must have been sized as their panes draw them");
}
#[test]
fn a_gui_pane_keeps_its_terminal_fitted_when_split() {
    in_own_process("gui_terminal_follows_split");
}

#[gpui::test]
fn gui_terminal_follows_split(cx: &mut gpui::TestAppContext) {
    use serde_json::json;
    if !running_alone("gui_terminal_follows_split") { return; }
    let layout = json!({"id": "context", "type": "block", "content": {"tab": "active", "pane": {
        "lone": true,
        "header": {"height": 30, "content": {"mod": "size-probe"}},
        "footer": {"height": 82, "view": "gui", "content": {"mod": "size-probe"}}
    }}});
    let (view, cx) = open_window(cx, "size-probe", "import { View, div } from 'gpui-kit'; export default class Probe extends View { render() { return div(); } }", layout);
    std::fs::write(crate::mods::app_dir().join("mods/size-probe/mod.json"),
        r#"{"place":"none","pane_view":{"id":"gui","label":"GUI","when":[{"label":"bridge"}]}}"#).unwrap();
    view.update_in(cx, |this, window, cx| {
        this.sync_folders(window, cx);
        this.folders.retain(|id, _| id == "size-probe");
        this.model = crate::model::Model::default();
        this.model.add_space("space", "test", "/", super::Tab::new("tab", "", "a", "probe-a"));
        this.live.insert("probe-a".into(), json!({"state":"live", "labels":{"bridge":"ready", "herdr.view":"gui"}}));
        this.sync(window, cx);
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(view.update(cx, |this, _| this.pane_view_mode("a")), "gui");
    view.update_in(cx, |this, window, cx| this.fit_hidden_tabs(window, cx));
    view.update_in(cx, |this, window, cx| this.fit_hidden_tabs(window, cx));
    let dims = |cx: &mut gpui::VisualTestContext| view.update(cx, |this, cx| this.terms["a"].view.read(cx).dimensions());
    let full = dims(cx);
    view.update_in(cx, |this, window, cx| {
        let tab = this.model.tab_mut("tab").unwrap();
        tab.root.split("a", super::Axis::Row, crate::model::pane("b", "probe-b"), "split".into());
        this.sync(window, cx);
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let fitted = dims(cx);
    assert!(fitted.0 < full.0, "splitting the active GUI must fit its hidden terminal");
    cx.simulate_resize(gpui::size(gpui::px(1400.0), gpui::px(900.0)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.update_in(cx, |this, window, cx| this.fit_hidden_tabs(window, cx));
    let resized = dims(cx);
    assert_ne!(resized, fitted, "an active GUI terminal must follow window geometry");
    view.update_in(cx, |this, window, cx| {
        this.live.get_mut("probe-a").unwrap()["labels"]["herdr.view"] = json!("tui");
        this.sync(window, cx);
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(dims(cx), resized, "showing the terminal must not change its grid");
}

#[test]
fn frame_geometry_excludes_filtered_and_hover_slots() {
    use super::pane_size::frame_slot_height;
    use serde_json::json;
    let frame: crate::layout::PaneFrame = serde_json::from_value(json!({
        "header": {"content": {"mod": "header"}, "height": 30},
        "footer": {"content": {"mod": "composer"}, "height": 82, "view": "gui"}
    })).unwrap();
    assert_eq!(frame_slot_height(&frame, "gui", None, None), 112.0);
    assert_eq!(frame_slot_height(&frame, "tui", None, None), 30.0);
    assert_eq!(frame_slot_height(&frame, "tui", Some(50.0), None), 50.0);
    let tui_footer: crate::layout::PaneFrame = serde_json::from_value(json!({
        "header": {"content": {"mod": "header"}, "height": 30, "view": "gui"},
        "footer": {"content": {"mod": "footer"}, "height": 40, "view": "tui"}
    })).unwrap();
    assert_eq!(frame_slot_height(&tui_footer, "gui", Some(50.0), None), 50.0);
    assert_eq!(frame_slot_height(&tui_footer, "tui", Some(50.0), None), 40.0);
    let hover: crate::layout::PaneFrame = serde_json::from_value(json!({
        "footer": {"content": {"mod": "composer"}, "height": 82, "reveal": "hover"}
    })).unwrap();
    assert_eq!(frame_slot_height(&hover, "gui", None, None), 0.0);
}

#[test]
fn a_header_request_stays_between_the_layouts_least_and_most() {
    use super::pane_size::pane_header_height;
    use serde_json::json;
    let header = |spec: serde_json::Value| -> crate::layout::Header { serde_json::from_value(spec).unwrap() };
    let both = header(json!({"content": {"mod": "x"}, "height": 40, "max_height": 120}));
    assert_eq!(pane_header_height(&both, None), 40.0, "no request: the layout's height");
    assert_eq!(pane_header_height(&both, Some(10.0)), 40.0, "the layout's height is the least");
    assert_eq!(pane_header_height(&both, Some(80.0)), 80.0);
    assert_eq!(pane_header_height(&both, Some(500.0)), 120.0, "max_height is the most");
    assert_eq!(pane_header_height(&both, Some(f32::NAN)), 40.0, "a request that is not a number is none");
    let plain = header(json!({"content": {"mod": "x"}}));
    assert_eq!(pane_header_height(&plain, None), 30.0);
    assert_eq!(pane_header_height(&plain, Some(1000.0)), 400.0, "the default most is 400");
    let inverted = header(json!({"content": {"mod": "x"}, "height": 50, "max_height": 20}));
    assert_eq!(pane_header_height(&inverted, Some(100.0)), 50.0, "a max_height under the least cannot shrink the header");
}

#[test]
fn a_header_request_gives_the_terminal_the_rows_it_leaves() {
    in_own_process("header_request_resizes");
}

#[gpui::test]
fn header_request_resizes(cx: &mut gpui::TestAppContext) {
    use serde_json::json;
    if !running_alone("header_request_resizes") { return; }
    let layout = json!({"id": "context", "type": "block", "content": {"tab": "active", "pane": {
        "lone": true, "header": {"height": 23, "max_height": 100, "position": "bottom", "content": {"mod": "size-probe"}}
    }}});
    let (view, cx) = open_window(cx, "size-probe", "export default () => null;", layout.clone());
    view.update_in(cx, |this, window, cx| {
        this.folders.retain(|id, _| id == "size-probe");
        this.chrome = serde_json::from_value(layout).unwrap();
        this.bounds.borrow_mut().clear();
        this.model = crate::model::Model::default();
        this.model.add_space("space", "test", "/", super::Tab::new("tab", "", "a", "probe-a"));
        this.sync(window, cx);
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let rows = |cx: &mut gpui::VisualTestContext| view.update(cx, |this, cx| this.terms["a"].view.read(cx).dimensions().1);
    let request = |cx: &mut gpui::VisualTestContext, px: Option<f32>| {
        view.update_in(cx, |this, window, cx| {
            match px {
                Some(px) => this.header_heights.insert("a".into(), px),
                None => this.header_heights.remove("a"),
            };
            this.sync(window, cx);
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        rows(cx)
    };
    let fixed = rows(cx);
    let tall = request(cx, Some(90.0));
    assert!(tall < fixed, "a taller header leaves the terminal fewer rows: {tall} vs {fixed}");
    // The size predicted for a pane must be the rendered one, with the request in force.
    let predicted = view.update_in(cx, |this, window, _| this.initial_size(&this.model.spaces[0].tabs[0].root.clone(), "a", window)).unwrap();
    assert_eq!(predicted.1, tall, "the predicted size follows the request");
    assert_eq!(request(cx, Some(5000.0)), request(cx, Some(100.0)), "a request over max_height gets max_height");
    assert_eq!(request(cx, Some(1.0)), fixed, "a request under the layout's height gets the layout's height");
    assert_eq!(request(cx, Some(90.0)), tall);
    assert_eq!(request(cx, None), fixed, "taking the request back restores the layout's height");
}
