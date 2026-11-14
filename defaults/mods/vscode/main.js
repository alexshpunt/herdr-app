import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { NativeAppState, NativeApp } from "herdr-browser";
import { props, theme, focused, nextCommand, nextLink, panes, shared, setShared, readTextFile, appHome } from "herdr";
import { appTarget } from "./uri.js";

// The person's own VS Code, embedded. As an app in a pane (`pane.app.open`,
// the Files button, a file or folder link) it opens the pane's project, or the
// folder of the link it was opened for, on the file that link names; files
// linked later open in the same window, a folder linked later replaces it.
// As a tab's mod pane it opens props.uri (a folder URI such as
// vscode-remote://wsl+Ubuntu/root/app) or props.folder (a local path), with
// props.goto (a file URI, `:line:column` after it) on that file. Closing the
// pane or app closes that VS Code window.
export default class VsCode extends View {
  init(_props, cx) {
    this.app = null;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        await this.start();
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
    // A pane's app is opened again with each link Herdr routes to it.
    if (typeof props()?.app === "string") {
      cx.spawn(async (cx) => {
        for (;;) {
          const opened = await nextLink();
          await this.reveal(opened);
          cx.notify();
        }
      });
    }
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

  async machines() {
    try { return JSON.parse(await readTextFile(`${appHome()}/machines.json`) ?? "[]"); } catch { return []; }
  }

  async start() {
    const p = props() ?? {};
    if (typeof p.app === "string") {
      const { folder, goto } = appTarget(p, await this.machines());
      this.folder = folder;
      this.app = NativeAppState("vscode", folder);
      if (goto) this.goto(goto);
      return;
    }
    this.app = NativeAppState("vscode", p.uri || p.folder || focused()?.cwd || "");
    this.openGoto();
  }

  // A link Herdr routes to this app later: a file opens in this window, a
  // folder in a window of its own, which replaces this one (the old state's
  // window closes once it is dropped).
  /** @param {any} opened */
  async reveal(opened) {
    const kind = opened?.link?.kind;
    if ((kind !== "file" && kind !== "folder") || !this.app) return;
    try {
      const { folder, goto } = appTarget({ ...props(), ...opened }, await this.machines());
      if (kind === "folder" && folder !== this.folder) {
        this.folder = folder;
        this.error = null;
        this.app = NativeAppState("vscode", folder);
      }
      if (goto) this.goto(goto);
    } catch (error) {
      console.error(`Cannot open ${opened.link.path}: ${error}`);
    }
  }

  /** @param {string} uri */
  goto(uri) {
    try { this.app.goto(uri); } catch (error) { console.error(`Cannot open ${uri}: ${error}`); }
  }

  // A tab opened for a file (props.goto: its file URI) starts its window on
  // it, once: shared("vscode.goto.opened")[its pane] remembers that it did, so
  // the window a restarted Herdr opens again is not moved to that line.
  openGoto() {
    const { goto, pane } = props() ?? {};
    if (!goto) return;
    const opened = shared("vscode.goto.opened") ?? {};
    if (pane && opened[pane] === goto) return;
    this.goto(goto);
    if (!pane) return;
    // Panes that are gone drop out; this one may not be in panes() yet.
    const live = new Set(panes().map((p) => p.pane));
    const kept = Object.fromEntries(Object.entries(opened).filter(([p]) => live.has(p)));
    setShared("vscode.goto.opened", { ...kept, [pane]: goto });
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
