import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { NativeAppState, NativeApp } from "herdr-browser";
import { props, theme, focused, nextCommand, readTextFile, appHome } from "herdr";

// The person's Fork (git client), embedded, on one repository: as an app in
// a pane (`pane.app.open`, the Diff button) the pane's project, as a tab's mod
// pane props.uri (a folder URI such as vscode-remote://wsl+Ubuntu/root/app)
// or props.folder (a local path). Each has a Fork process of its own with only
// this repository; closing the pane or app closes it.
export default class ForkApp extends View {
  init(_props, cx) {
    this.app = null;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        this.app = NativeAppState("fork", await this.target());
      } catch (error) {
        this.error = String(error?.message ?? error);
      }
      cx.notify();
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
        const now = `${this.app?.status()}|${this.app?.error()}|${this.error}`;
        if (now !== last) { last = now; cx.notify(); }
      }
    });
  }

  // A folder Fork on this computer opens: a local one, a WSL machine's
  // (`editorAuthority` `wsl+<distro>` in machines.json), or a URI as given.
  async target() {
    const p = props() ?? {};
    const project = typeof p.app === "string" ? p.project : null;
    if (!project) return p.uri || p.folder || focused()?.cwd || "";
    if (project.machine == null) return project.folder;
    let machines = [];
    try { machines = JSON.parse(await readTextFile(`${appHome()}/machines.json`) ?? "[]"); } catch { /* No routes: below. */ }
    const authority = machines.find((m) => m.name === project.machine)?.editorAuthority ?? "";
    if (!authority.startsWith("wsl+")) throw new Error(`Fork opens folders on this computer and its WSL, not on ${project.machine}.`);
    const mount = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(project.folder);
    if (mount) return `${mount[1].toUpperCase()}:\\${(mount[2] ?? "").replaceAll("/", "\\")}`;
    return `vscode-remote://${authority}${project.folder.split("/").map(encodeURIComponent).join("/")}`;
  }

  render() {
    const t = theme();
    const error = this.error || this.app?.error();
    const status = this.app?.status() ?? "Opening…";
    // The window covers this pane once it is shown; until then, or after it
    // closes, the pane says why it is empty.
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
