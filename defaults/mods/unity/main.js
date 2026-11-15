import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { NativeAppState, NativeApp } from "herdr-browser";
import { props, theme, focused, nextCommand, nextLink, readTextFile, env } from "herdr";
import { editorVersion, localFolder, unityLaunch, unityRoots } from "./launch.js";

// The Unity Editor, embedded, on a Unity project in the editor version the
// project names: as an app (`app.open`, the Unity button, a Unity project's
// folder link) the link's folder or its agent's project, as a
// tab's mod pane props.folder (a local path) or props.uri (a file:// URI). An
// editor that already has the project open moves in. Closing the pane or app
// closes the editor, as its own close button does.
export default class UnityEditor extends View {
  init(_props, cx) {
    this.app = null;
    this.error = null;
    cx.spawn(async (cx) => {
      await this.open(props() ?? {});
      cx.notify();
    });
    // An app gets each later Unity project's folder link Herdr routes
    // to it: that project replaces this one (the old state's editor closes
    // once it is dropped).
    if (typeof props()?.app === "string") {
      cx.spawn(async (cx) => {
        for (;;) {
          const opened = await nextLink();
          if (opened?.link?.kind === "folder") await this.open({ ...props(), ...opened });
          cx.notify();
        }
      });
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
        const now = `${this.app?.status()}|${this.app?.error()}|${this.error}`;
        if (now !== last) { last = now; cx.notify(); }
      }
    });
  }

  /** Opens the editor on the project props `p` name, unless it has it open. @param {any} p */
  async open(p) {
    try {
      const folder = this.target(p);
      if (this.app && folder === this.project) return;
      const text = await readTextFile(`${folder}\\ProjectSettings\\ProjectVersion.txt`);
      if (text == null) throw new Error(`${folder} is not a Unity project`);
      const version = editorVersion(text);
      if (!version) throw new Error(`${folder}\\ProjectSettings\\ProjectVersion.txt names no editor version`);
      const appData = env("APPDATA");
      const chosen = appData ? await readTextFile(`${appData}\\UnityHub\\secondaryInstallPath.json`) : null;
      const description = unityLaunch(folder, version, unityRoots(env, chosen));
      const app = NativeAppState(`unity\n${folder}`);
      app.open(description);
      this.project = folder;
      this.error = null;
      this.app = app;
    } catch (error) {
      this.error = String(error?.message ?? error);
    }
  }

  // A project on this computer: a Windows folder, or a WSL machine's
  // `/mnt/<drive>/…` folder as that drive's.
  /** @param {any} p its props, or those of a later `app.open` */
  target(p) {
    if (typeof p.app !== "string") {
      const given = p.folder || p.uri || focused()?.cwd || "";
      const folder = localFolder(given);
      if (!folder) throw new Error(given ? `Unity opens projects on this computer's drives, not ${given}.` : "No Unity project to open.");
      return folder;
    }
    const where = p.link?.kind === "folder" ? { folder: p.link.path, machine: p.link.machine ?? null } : p.project;
    if (!where?.folder) throw new Error("No Unity project to open.");
    if (where.machine == null) return localFolder(where.folder) ?? where.folder;
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
