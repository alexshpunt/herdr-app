// How Herdr starts Fork (the git client) for a pane: a Fork process of the
// pane's own on one repository. Fork started with a folder hands it to a
// running Fork and exits; started with none, it is a new process that
// restores the tabs of its active workspace. So the pane writes a "Herdr"
// workspace of only its repository into Fork's settings first.

/** The name of the Fork workspace that Herdr's panes start Fork in. */
export const WORKSPACE = "Herdr";

/** `%XX` escapes decoded; `+` stays itself. @param {string} s */
function decoded(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Where Fork.exe may be: `HERDR_FORK_EXE`, then its per-user installs.
 * @param {(name: string) => string | null} env
 */
export function forkPrograms(env) {
  const local = env("LOCALAPPDATA");
  return [
    env("HERDR_FORK_EXE"),
    local && `${local}\\Fork\\current\\Fork.exe`,
    local && `${local}\\Fork\\Fork.exe`,
  ].filter((p) => typeof p === "string" && p !== "");
}

/**
 * A Windows path for a folder given as a path or a folder URI (`file://`,
 * `vscode-remote://wsl+<distro>`), without a trailing separator.
 * @param {string} target
 */
export function windowsFolder(target) {
  target = target.trim();
  if (!target) throw new Error("No folder to open");
  let folder = target;
  const cut = target.indexOf("://");
  if (cut >= 0) {
    const scheme = target.slice(0, cut);
    const rest = target.slice(cut + 3);
    const slash = rest.indexOf("/");
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    const path = decoded(slash < 0 ? "" : rest.slice(slash + 1)).replaceAll("/", "\\");
    const distro = scheme === "vscode-remote" ? /^wsl\+(.+)$/.exec(decoded(authority))?.[1] : null;
    if (scheme === "file") folder = authority ? `\\\\${authority}\\${path}` : path;
    else if (distro) folder = `\\\\wsl.localhost\\${distro}\\${path}`;
    else throw new Error(`Only local and WSL folders open on Windows, not ${target}`);
  }
  while (folder.length > 3 && /[\\/]$/.test(folder)) folder = folder.slice(0, -1);
  return folder;
}

/**
 * Fork's settings with the "Herdr" workspace holding only `folder`, made
 * active. Other workspaces and settings stay as they are.
 * @param {any} settings Fork's parsed settings.json
 * @param {string} folder
 */
export function forkWorkspace(settings, folder) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Fork's settings are not a JSON object");
  if (settings.Workspaces == null) settings.Workspaces = {};
  const workspaces = settings.Workspaces;
  if (typeof workspaces !== "object" || Array.isArray(workspaces)) throw new Error("Fork's Workspaces setting is not an object");
  if (workspaces.All == null) workspaces.All = [];
  const all = workspaces.All;
  if (!Array.isArray(all)) throw new Error("Fork's workspace list is not an array");
  let workspace = all.find((w) => w?.Name === WORKSPACE);
  if (!workspace) all.push(workspace = { Name: WORKSPACE });
  if (typeof workspace !== "object") throw new Error("A Fork workspace is not an object");
  workspace.Repositories = [folder];
  workspace.ActiveRepository = folder;
  workspaces.ActiveWorkspace = WORKSPACE;
  return settings;
}

/**
 * The `safe.directory` entry git asks for a UNC folder (WSL folders are
 * `\\wsl.localhost\...`), which another user owns; null for a local drive,
 * which the person owns.
 * @param {string} folder
 */
export function safeDirectory(folder) {
  if (!folder.startsWith("\\\\")) return null;
  return `%(prefix)///${folder.slice(2).replaceAll("\\", "/")}`;
}

/**
 * The gits Fork may run, in order: its `GitInstancePath` setting, its bundled
 * gits (`gitInstance\<version>`, newest first), then the one on PATH.
 * @param {string} dir Fork's folder, %LOCALAPPDATA%\Fork
 * @param {any} settings Fork's parsed settings.json, or null
 * @param {{name: string, folder: boolean, modified: number | null}[] | null} bundled the entries of gitInstance
 */
export function forkGits(dir, settings, bundled) {
  const chosen = typeof settings?.GitInstancePath === "string" && settings.GitInstancePath ? settings.GitInstancePath : null;
  const newest = (bundled ?? []).filter((e) => e.folder).sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
  return [
    ...(chosen ? [`${chosen}\\bin\\git.exe`, chosen] : []),
    ...newest.map((e) => `${dir}\\gitInstance\\${e.name}\\bin\\git.exe`),
    "git",
  ];
}

/**
 * The launch description of a Fork process of the pane's own: its window is
 * the new one of that process (a WPF window, a GUID in its class per run).
 * @param {(name: string) => string | null} env
 */
export function forkLaunch(env) {
  const program = forkPrograms(env);
  if (!program.length) throw new Error("Fork is not installed (set HERDR_FORK_EXE to Fork.exe)");
  return { program, args: [], class: "HwndWrapper[Fork.exe;*", ownProcess: true, missing: "Fork is not installed (set HERDR_FORK_EXE to Fork.exe)" };
}
