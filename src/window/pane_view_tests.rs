#[test]
fn pane_views_keep_their_copies_and_keyboard_across_switches() {
    in_own_process("pane_view_switching");
}

#[gpui::test]
fn pane_view_switching(cx: &mut gpui::TestAppContext) {
    use serde_json::json;
    if !running_alone("pane_view_switching") {
        return;
    }
    let probe = r#"import { View, div } from 'gpui-kit';
import { Input, InputState } from 'gpui-base';
import { nextCommand, props, setShared, shared } from 'herdr';
export default class Probe extends View {
  init(_, cx) {
    this.pane = props().pane;
    this.field = InputState.new({ value: this.pane });
    cx.spawn(async () => {
      for (;;) {
        if (await nextCommand() === 'focus') {
          const key = 'pane-view.focus.' + this.pane;
          setShared(key, (shared(key) ?? 0) + 1);
          this.field.focus();
        }
      }
    });
  }
  render() { return div().size_full().child(Input.new(this.field)); }
}
"#;
    let layout = json!({"id":"context", "type":"block", "content":{"tab":"active"}});
    let (view, cx) = open_window(cx, "pane-probe", probe, layout);
    let manifest = crate::mods::app_dir().join("mods/pane-probe/mod.json");
    std::fs::write(
        manifest,
        r#"{"place":"none","pane_view":{"id":"gui","label":"GUI","when":[{"label":"bridge"}]}}"#,
    )
    .unwrap();
    view.update_in(cx, |this, window, cx| {
        this.sync_folders(window, cx);
        this.folders.retain(|id, _| id == "pane-probe");
        this.model = crate::model::Model::default();
        let mut tab = super::Tab::new("tab", "", "a", "term-a");
        tab.root.split(
            "a",
            super::Axis::Row,
            crate::model::pane("b", "term-b"),
            "split".into(),
        );
        tab.focus("a");
        this.model.add_space("space", "test", "/", tab);
        for term in ["term-a", "term-b"] {
            this.live.insert(
                term.into(),
                json!({"state":"live", "labels":{"bridge":"ready", "herdr.view":"gui"}}),
            );
        }
        window.activate_window();
        this.sync(window, cx);
    });
    let draw = |cx: &mut gpui::VisualTestContext| {
        cx.update(|window, cx| {
            window.simulate_next_frame(cx);
            window.draw(cx).clear(cx);
        });
        cx.run_until_parked();
    };
    draw(cx);
    // Clicking outside the input in the other GUI pane must hand it the keyboard.
    let point_in_b = view.update(cx, |this, _| {
        let bounds = this.bounds.borrow()["b"];
        gpui::point(
            bounds.origin.x + bounds.size.width / 2.0,
            bounds.origin.y + bounds.size.height - gpui::px(10.0),
        )
    });
    cx.simulate_mouse_down(
        point_in_b,
        gpui::MouseButton::Left,
        gpui::Modifiers::default(),
    );
    cx.simulate_mouse_up(
        point_in_b,
        gpui::MouseButton::Left,
        gpui::Modifiers::default(),
    );
    draw(cx);
    assert_eq!(crate::mods::shared("pane-view.focus.b"), Some(json!(1)));
    view.update_in(cx, |this, window, cx| {
        this.model.focus_pane("a");
        this.focused_pane = None;
        this.sync(window, cx);
    });
    draw(cx);
    view.update_in(cx, |this, window, cx| {
        for term in ["term-a", "term-b"] {
            this.live.get_mut(term).unwrap()["labels"]["herdr.view"] = json!("tui");
        }
        this.sync(window, cx);
    });
    draw(cx);
    let baseline_focus = crate::mods::shared("pane-view.focus.a")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let (copy_a, copy_b, grid) = view.update(cx, |this, cx| {
        let owned = this.owned_mods();
        assert!(owned.contains_key("a#view") && owned.contains_key("b#view"));
        let visible = this.visible().1;
        assert!(!visible.iter().any(|(slot, _)| slot.ends_with("#view")));
        (
            this.copies["a#view"].id,
            this.copies["b#view"].id,
            this.terms["a"].view.read(cx).dimensions(),
        )
    });
    for cycle in 0..10 {
        for mode in ["gui", "tui"] {
            view.update_in(cx, |this, window, cx| {
                // The offline test core rejects writes; its label represents the acknowledged value.
                this.live.get_mut("term-a").unwrap()["labels"]["herdr.view"] = json!(mode);
                let result = this.run_as(
                    "pane.view",
                    json!({"pane":"a", "view":mode}),
                    false,
                    window,
                    cx,
                );
                assert!(result.get("error").is_none(), "{result}");
                assert_eq!(this.pane_view_mode("a"), mode);
                assert_eq!(this.pane_view_mode("b"), "tui");
                assert_eq!(
                    serde_json::to_value(&this.person).unwrap()["default_pane_view"],
                    mode
                );
                let visible = this.visible().1;
                assert_eq!(
                    visible.iter().any(|(slot, _)| slot == "a#view"),
                    mode == "gui"
                );
                assert!(!visible.iter().any(|(slot, _)| slot == "b#view"));
                assert_eq!(this.copies["a#view"].id, copy_a);
                assert_eq!(this.copies["b#view"].id, copy_b);
            });
            draw(cx);
            view.update(cx, |this, cx| {
                assert_eq!(this.terms["a"].view.read(cx).dimensions(), grid)
            });
            if mode == "gui" {
                assert_eq!(
                    crate::mods::shared("pane-view.focus.a"),
                    Some(json!(baseline_focus + cycle + 1))
                );
            } else {
                cx.update(|window, cx| {
                    view.update(cx, |this, _| {
                        assert!(this.terms["a"].focus.is_focused(window))
                    })
                });
            }
        }
    }
    view.update_in(cx, |this, window, cx| {
        this.live.get_mut("term-b").unwrap()["labels"]["herdr.view"] = json!("gui");
        let result = this.run_as(
            "pane.view",
            json!({"terminal":"term-b", "view":"gui"}),
            false,
            window,
            cx,
        );
        assert!(result.get("error").is_none(), "{result}");
        assert_eq!(this.pane_view_mode("a"), "tui");
        assert_eq!(this.pane_view_mode("b"), "gui");
        this.swapped.insert("a".into(), "remote/child".into());
        this.live.insert(
            "remote/child".into(),
            json!({"state":"live", "labels":{"bridge":"ready"}}),
        );
        let swapped = this.run_as(
            "pane.view",
            json!({"terminal":"remote/child", "view":"gui"}),
            false,
            window,
            cx,
        );
        assert!(
            swapped.get("error").is_none(),
            "a shown remote terminal must be targetable: {swapped}"
        );
        assert_eq!(
            this.written_views.get("remote/child").map(String::as_str),
            Some("gui")
        );
        this.live.get_mut("term-b").unwrap()["labels"]
            .as_object_mut()
            .unwrap()
            .remove("bridge");
        this.sync(window, cx);
        assert_eq!(
            this.pane_view_mode("b"),
            "tui",
            "a missing bridge falls back to the terminal"
        );
        let gui = this
            .pane_view_options("b")
            .into_iter()
            .find(|v| v["id"] == "gui")
            .unwrap();
        assert_eq!(gui["available"], false);
        assert!(gui["reason"].is_string());
        assert!(!this.visible().1.iter().any(|(slot, _)| slot == "b#view"));
    });
}

#[test]
fn footer_mod_resizes_only_its_own_slot() {
    in_own_process("footer_mod_height");
}

#[gpui::test]
fn footer_mod_height(cx: &mut gpui::TestAppContext) {
    use serde_json::json;
    if !running_alone("footer_mod_height") {
        return;
    }
    let probe = r#"import { View, div } from 'gpui-kit';
import { props, run } from 'herdr';
export default class Footer extends View {
  init() { run('pane.header_height', {pane: props().pane, px: 120}); }
  render() { return div().size_full(); }
}"#;
    let layout = json!({"id":"context","type":"block","content":{"tab":"active","pane":{
        "lone":true,
        "header":{"content":"tabs","height":30},
        "footer":{"content":{"mod":"footer-probe"},"height":50}
    }}});
    let (view, cx) = open_window(cx, "footer-probe", probe, layout);
    view.update_in(cx, |this, window, cx| {
        this.model
            .add_space("s", "test", "/", super::Tab::new("t", "", "p", "term"));
        this.live
            .insert("term".into(), json!({"state":"live", "labels":{}}));
        this.sync(window, cx);
    });
    for _ in 0..3 {
        cx.update(|window, cx| {
            window.simulate_next_frame(cx);
            window.draw(cx).clear(cx);
        });
        cx.run_until_parked();
    }
    view.update(cx, |this, _| {
        assert_eq!(this.footer_heights.get("p"), Some(&120.0));
        assert_eq!(this.header_heights.get("p"), None);
        let frame = this.pane_frame().unwrap();
        assert_eq!(
            super::pane_size::frame_slot_height(
                frame,
                "tui",
                None,
                this.footer_heights.get("p").copied()
            ),
            150.0
        );
    });
}
