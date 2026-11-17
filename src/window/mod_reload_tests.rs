#[test]
fn opening_a_new_mod_does_not_replay_its_pending_creation_events() {
    in_own_process("pending_mod_creation");
}

#[gpui::test]
fn pending_mod_creation(cx: &mut gpui::TestAppContext) {
    use serde_json::json;
    use std::time::{Duration, Instant};
    if !running_alone("pending_mod_creation") { return; }
    let (view, cx) = open_window(cx, "unused", "", json!({
        "id": "root", "type": "block", "titlebar": "none", "content": { "tab": "active" }
    }));
    let folder = crate::mods::app_dir().join("mods/pending-probe");
    let events = view.update(cx, |this, _| this.file_events.clone().expect("native watcher"));
    let revision = events.revision_provider();
    let source = "import { View, div } from 'gpui-kit'; import { shared, setShared } from 'herdr'; export default class Probe extends View { init() { setShared('probe.starts', (shared('probe.starts') ?? 0) + 1); } render() { return div().child('probe'); } }";
    std::fs::create_dir_all(&folder).unwrap();
    let folder = folder.canonicalize().unwrap();
    std::fs::write(folder.join("main.js"), source).unwrap();
    std::fs::write(folder.join("mod.json"), r#"{"place":"right","size":200}"#).unwrap();
    let wait_for_event = |before: u64| {
        let deadline = Instant::now() + Duration::from_secs(5);
        while revision(&folder).unwrap_or(0) <= before {
            assert!(Instant::now() < deadline, "native file notification did not arrive");
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    wait_for_event(0);
    std::thread::sleep(Duration::from_millis(200));
    // Opening the app scans its folder before the queued creation events run.
    view.update_in(cx, |this, window, cx| this.sync_folders(window, cx));
    assert_eq!(crate::mods::shared("probe.starts"), Some(json!(1)));
    for _ in 0..10 {
        cx.executor().advance_clock(Duration::from_millis(100));
        cx.run_until_parked();
    }
    assert_eq!(crate::mods::shared("probe.starts"), Some(json!(1)), "creation events must not restart a copy that already loaded those files");
    let before = revision(&folder).unwrap();
    std::fs::write(folder.join("main.js"), format!("{source}\n// Later edit\n")).unwrap();
    wait_for_event(before);
    for _ in 0..10 {
        cx.executor().advance_clock(Duration::from_millis(100));
        cx.run_until_parked();
    }
    assert_eq!(crate::mods::shared("probe.starts"), Some(json!(2)), "a real edit after opening still reloads the copy");
}
