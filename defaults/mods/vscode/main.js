import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { NativeAppState, NativeApp } from "herdr-browser";
import { props, theme, focused, nextCommand, nextLink, panes, shared, setShared, readTextFile, appHome, exec, env } from "herdr";
import { appTarget, outsideFolder } from "./uri.js";
import { HAND_AGAIN, roundsPast, vscodeLaunch } from "./launch.js";

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
    // The pane's message follows the window's state while it is not shown,
    // and files go to the window once it is.
    cx.spawn(async (cx) => {
      let last = "";
      for (;;) {
        await cx.sleep(250);
        this.handOff();
        const now = `${this.app?.status()}|${this.app?.error()}|${this.error}`;
        if (now !== last) { last = now; cx.notify(); }
      }
    });
  }

  async machines() {
    try { return JSON.parse(await readTextFile(`${appHome()}/machines.json`) ?? "[]"); } catch { return []; }
  }

  // A file link outside the pane's project opens in its own Git work tree
  // (else its folder, below): its project, as the pane's would be.
  /** @param {any} p */
  async withLinkProject(p) {
    const folder = outsideFolder(p);
    if (!folder) return p;
    const machine = p.link.machine ?? null;
    try {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on: machine ?? undefined });
      const root = top.code === 0 ? top.stdout.trim() : "";
      if (root) return { ...p, project: { folder: machine == null ? root.replaceAll("/", "\\") : root, machine } };
    } catch { /* The machine is away or Git is missing: the file's folder. */ }
    return p;
  }

  async start() {
    const p = props() ?? {};
    if (typeof p.app === "string") {
      const { folder, goto } = appTarget(await this.withLinkProject(p), await this.machines());
      this.open(folder, goto);
      return;
    }
    this.open(p.uri || p.folder || focused()?.cwd || "", this.tabGoto());
  }

  /**
   * A VS Code window on `folder` in this pane, with `goto` (a file URI,
   * `:line:column` after it) open in it. The state's key is the folder: a
   * restarted copy of this mod, or another pane on that folder, takes its
   * window over, as VS Code has one window per folder.
   * @param {string} folder
   * @param {string | null} goto
   */
  open(folder, goto) {
    const { description, later } = vscodeLaunch(folder, goto, env);
    this.folder = folder;
    this.error = null;
    const app = NativeAppState(`vscode\n${folder}`);
    app.open(description);
    this.app = app;
    // What goes to the window once it is shown (handOff): `later`, the line of
    // the file a new window opened with; `goto`, that file for a window that
    // was open already; `queued`, the files linked while it started.
    this.window = { app, adopted: null, round: 0, handed: [], later, goto, queued: [] };
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
      if (kind === "folder" && folder !== this.folder) return this.open(folder, goto);
      if (goto) this.goto(goto);
    } catch (error) {
      console.error(`Cannot open ${opened.link.path}: ${error}`);
    }
  }

  // A running VS Code opens a file it is handed (`--goto --file-uri`) in the
  // window that has its folder. While the window starts, the file waits for
  // it: a Code.exe started meanwhile could open a window of its own.
  /** @param {string} uri */
  goto(uri) {
    const w = this.window;
    if (!w) return;
    if (w.adopted == null) { w.queued.push(uri); return; }
    this.hand(w, [uri]);
  }

  /** Hands files to the window, and keeps them for its later rounds. @param {any} w @param {string[]} uris */
  hand(w, uris) {
    for (const uri of uris) {
      w.handed = [...w.handed.filter((u) => u !== uri), uri];
      try { w.app.run(["--goto", "--file-uri", uri]); } catch (error) { console.error(`Cannot open ${uri}: ${error}`); }
    }
  }

  // Once the window is shown, the files asked for so far go to it, the last
  // one in front. While a new window may still be connecting to its machine,
  // every file it was handed goes again at each HAND_AGAIN round still ahead:
  // a file open by then takes its line.
  handOff() {
    const w = this.window;
    if (!w || w.app !== this.app || !w.app.shown()) return;
    if (w.adopted == null) {
      w.adopted = w.app.embeddedAt() ?? Date.now();
      w.round = roundsPast(w.adopted, Date.now());
      // A window from another pane gets this pane's file; one a restarted
      // copy of this mod left has it open already.
      const first = { new: w.later, pane: w.goto }[w.app.origin() ?? ""] ?? null;
      this.hand(w, [first, ...w.queued].filter((uri) => typeof uri === "string"));
      w.queued = [];
    }
    while (w.round < HAND_AGAIN.length && Date.now() >= w.adopted + HAND_AGAIN[w.round]) {
      w.round += 1;
      this.hand(w, w.handed);
    }
  }

  // A tab opened for a file (props.goto: its file URI) starts its window on
  // it, once: shared("vscode.goto.opened")[its pane] remembers that it did, so
  // the window a restarted Herdr opens again is not moved to that line.
  tabGoto() {
    const { goto, pane } = props() ?? {};
    if (!goto) return null;
    const opened = shared("vscode.goto.opened") ?? {};
    if (pane && opened[pane] === goto) return null;
    if (pane) {
      // Panes that are gone drop out; this one may not be in panes() yet.
      const live = new Set(panes().map((p) => p.pane));
      const kept = Object.fromEntries(Object.entries(opened).filter(([p]) => live.has(p)));
      setShared("vscode.goto.opened", { ...kept, [pane]: goto });
    }
    return goto;
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
