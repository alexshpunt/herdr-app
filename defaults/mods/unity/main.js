import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { NativeAppState, NativeApp } from "herdr-browser";
import { props, theme, focused, nextCommand } from "herdr";

// The Unity Editor, embedded, on a Unity project in the editor version the
// project names: as an app in a pane (`pane.app.open`, the Unity button, a
// Unity project's folder link) the link's folder or the pane's project, as a
// tab's mod pane props.folder (a local path) or props.uri (a file:// URI). An
// editor that already has the project open moves in. Closing the pane or app
// closes the editor, as its own close button does.
export default class UnityEditor extends View {
  init(_props, cx) {
    this.app = null;
    this.error = null;
    try {
      this.app = NativeAppState("unity", this.target());
    } catch (error) {
      this.error = String(error?.message ?? error);
    }
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.app?.focus();
        cx.notify();
      }
    });
    // The pane's message follows the window's state while it is not shown.
    cx.spawn(async (cx) => {
      let last = "";
      for (;;) {
        await cx.sleep(500);
        const now = `${this.app?.status()}|${this.app?.error()}`;
        if (now !== last) { last = now; cx.notify(); }
      }
    });
  }

  // A project on this computer: a Windows folder, or a WSL machine's
  // `/mnt/<drive>/…` folder as that drive's.
  target() {
    const p = props() ?? {};
    if (typeof p.app !== "string") return p.folder || p.uri || focused()?.cwd || "";
    const where = p.link?.kind === "folder" ? { folder: p.link.path, machine: p.link.machine ?? null } : p.project;
    if (!where?.folder) throw new Error("No Unity project to open.");
    if (where.machine == null) return where.folder;
    const mount = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(where.folder);
    if (!mount) throw new Error(`Unity opens projects on this computer's drives, not ${where.folder} on ${where.machine}.`);
    return `${mount[1].toUpperCase()}:\\${(mount[2] ?? "").replaceAll("/", "\\")}`;
  }

  render() {
    const t = theme();
    const error = this.error || this.app?.error();
    const status = this.app?.status() ?? "";
    // The window covers this pane once it is shown; until then, or after it
    // closes, the pane says why it is empty. Unity shows its own progress
    // while it opens the project.
    const message = v_flex().absolute().size_full().items_center().justify_center().gap(10)
      .text_size(13).text_color(error ? t.blocked : t.muted)
      .child(div().child(error || status))
      .when(Boolean(this.app) && (Boolean(error) || status === "Closed."), el => el.child(
        div().id("reopen").px(10).py(5).rounded(5).bg(t.hover).text_color(t.foreground).cursor_pointer()
          .on_click((_event, cx) => { this.app.reopen(); cx.notify(); })
          .child("Open again")));
    return div().relative().size_full().bg(t.surface)
      .child(message)
      .when(Boolean(this.app), el => el.child(NativeApp(this.app).size_full()));
  }
}
