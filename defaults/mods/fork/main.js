import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { NativeAppState, NativeApp } from "herdr-browser";
import { props, theme, focused, nextCommand, readTextFile, writeTextFile, listFolder, appHome, exec, env, shared, setShared } from "herdr";
import { forkGits, forkLaunch, forkWorkspace, safeDirectory, windowsFolder } from "./launch.js";

// The person's Fork (git client), embedded, on one repository: as an app
// (`app.open`, the Diff button) its agent's project, as a tab's mod
// pane props.uri (a folder URI such as vscode-remote://wsl+Ubuntu/root/app)
// or props.folder (a local path). Each has a Fork process of its own with only
// this repository; closing the pane or app closes it.

/** shared(): the copy that starts a Fork now, `{id, until}`. The copy renews
 * `until` while it starts: a copy that goes away mid-start (a mod restart)
 * stops renewing, and the next start goes ahead `START_LEASE` later. */
const STARTING = "fork.starting";
const START_LEASE = 4000;
/** How long a start waits for its window before it lets the next one go. */
const START_WAIT = 30000;

export default class ForkApp extends View {
  init(_props, cx) {
    this.app = null;
    this.error = null;
    this.waiting = false;
    /** "Open again" was pressed: the next start reopens the window. */
    this.again = false;
    cx.spawn(async (cx) => {
      try {
        this.folder = windowsFolder(await this.target());
        await this.start(cx);
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
    // The pane's message follows the window's state while it is not shown,
    // and "Open again" starts Fork as the first start did.
    cx.spawn(async (cx) => {
      let last = "";
      for (;;) {
        await cx.sleep(200);
        if (this.again) {
          try { await this.start(cx); } catch (error) { this.error = String(error?.message ?? error); }
          this.again = false;
        }
        const now = `${this.app?.status()}|${this.app?.error()}|${this.error}|${this.waiting}`;
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

  /**
   * Starts this pane's Fork on its folder, or again after it closed or
   * failed ("Open again"). Fork reads its settings when it
   * starts: one start at a time across panes (a restarted Herdr starts every
   * Diff app at once), each with its own repository there, until its window
   * shows.
   * @param {any} cx
   */
  async start(cx) {
    const folder = this.folder;
    const fresh = !this.app;
    const description = fresh ? forkLaunch(env) : null;
    const app = this.app ?? NativeAppState(`fork\n${folder}`);
    this.app = app;
    cx.notify();
    // Let the state take a kept window after this initialization commits,
    // including in a hidden pane. No launch lease or preparation is needed.
    if (fresh) await cx.sleep(0);
    if (app.shown()) {
      if (fresh) app.open(description);
      return;
    }
    const id = `${props()?.pane ?? ""}/${Math.random()}`;
    // The state starts when its element first renders: an app in a pane no
    // one sees takes its turn once it shows.
    while (!this.rendered) await cx.sleep(200);
    for (;;) {
      const held = /** @type {any} */ (shared(STARTING));
      if (!held || held.until < Date.now()) break;
      if (!this.waiting) { this.waiting = true; cx.notify(); }
      await cx.sleep(200);
    }
    this.waiting = false;
    const renew = () => setShared(STARTING, { id, until: Date.now() + START_LEASE });
    renew();
    try {
      // Fork's settings and its git may take seconds: the lease is renewed
      // meanwhile.
      let prepared = false;
      this.prepare(folder)
        .catch((error) => console.error(`Cannot give Fork the pane's repository: ${error?.message ?? error}`))
        .finally(() => { prepared = true; });
      while (!prepared) {
        renew();
        await cx.sleep(200);
      }
      if (fresh) app.open(description);
      else app.reopen();
      cx.notify();
      const until = Date.now() + START_WAIT;
      while (!app.shown() && !app.error() && Date.now() < until) {
        renew();
        await cx.sleep(200);
      }
    } finally {
      if (/** @type {any} */ (shared(STARTING))?.id === id) setShared(STARTING, null);
    }
  }

  // The "Herdr" workspace of Fork's settings (%LOCALAPPDATA%\Fork\settings.json)
  // gets only `folder` and becomes active, and `folder` is marked safe for
  // Fork's git. Without that file Fork has never run: then it starts empty.
  /** @param {string} folder */
  async prepare(folder) {
    const local = env("LOCALAPPDATA");
    if (!local) throw new Error("LOCALAPPDATA is not set");
    const dir = `${local}\\Fork`;
    const path = `${dir}\\settings.json`;
    const text = await readTextFile(path);
    const settings = text == null ? null : JSON.parse(text.replace(/^\uFEFF/, ""));
    let trusted = null;
    try { await this.trust(dir, settings, folder); } catch (error) { trusted = error; }
    if (settings) await writeTextFile(path, JSON.stringify(forkWorkspace(settings, folder), null, 2), text);
    if (trusted) throw trusted;
  }

  // Git refuses a repository that another user owns, as every WSL one is
  // (`\\wsl.localhost\...`), until it is a `safe.directory`. Herdr opens the
  // person's own repositories: add it to the global git config with Fork's
  // git, as Fork's "Mark repository as safe" does.
  /** @param {string} dir @param {any} settings @param {string} folder */
  async trust(dir, settings, folder) {
    const entry = safeDirectory(folder);
    if (!entry) return;
    const gits = forkGits(dir, settings, await listFolder(`${dir}\\gitInstance`));
    for (const git of gits) {
      let listed;
      try { listed = await exec(git, ["config", "--global", "--get-all", "safe.directory"]); } catch { continue; }
      if (listed.stdout.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === "*")) return;
      const added = await exec(git, ["config", "--global", "--add", "safe.directory", entry]);
      if (added.code !== 0) throw new Error(`${git} cannot mark ${folder} safe: ${added.stderr.trim()}`);
      return;
    }
    throw new Error("No git to mark the repository safe with");
  }

  render() {
    this.rendered = true;
    const t = theme();
    const error = this.error || this.app?.error();
    const status = this.waiting ? "Waiting for another Fork to start…" : this.app?.status() ?? "Opening…";
    // The window covers this pane once it is shown; until then, or after it
    // closes, the pane says why it is empty.
    const message = v_flex().absolute().size_full().items_center().justify_center().gap(10)
      .text_size(13).text_color(error ? t.blocked : t.muted)
      .child(div().child(error || status))
      .when(Boolean(this.app) && (Boolean(error) || status === "Closed."), el => el.child(
        div().id("reopen").px(10).py(5).rounded(5).bg(t.hover).text_color(t.foreground).cursor_pointer()
          .on_click(() => { this.again = true; })
          .child("Open again")));
    return div().relative().size_full().bg(t.surface)
      .child(message)
      .when(Boolean(this.app), el => el.child(NativeApp(this.app).size_full()));
  }
}
