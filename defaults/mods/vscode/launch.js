// How Herdr starts VS Code for a pane (NativeAppState's launch description):
// the person's own Code.exe, default profile and user data, so a running VS
// Code opens the new window itself.

/** `%XX` escapes decoded; `+` stays itself. @param {string} s */
function decoded(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Where Code.exe may be: `HERDR_VSCODE_EXE`, then the user and the machine
 * installs.
 * @param {(name: string) => string | null} env
 */
export function codePrograms(env) {
  const local = env("LOCALAPPDATA");
  const programs = env("ProgramFiles");
  return [
    env("HERDR_VSCODE_EXE"),
    local && `${local}\\Programs\\Microsoft VS Code\\Code.exe`,
    programs && `${programs}\\Microsoft VS Code\\Code.exe`,
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
 * A VS Code URI as the machine `--remote` takes (null for this computer) and
 * the path there; null for a URI VS Code takes no path for.
 * @param {string} uri
 * @returns {[string | null, string] | null}
 */
function location(uri) {
  const cut = uri.indexOf("://");
  if (cut < 0) return null;
  const scheme = uri.slice(0, cut);
  const rest = uri.slice(cut + 3);
  const slash = rest.indexOf("/");
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? "" : rest.slice(slash + 1);
  if (scheme === "file") {
    try { return [null, windowsFolder(uri)]; } catch { return null; }
  }
  if (scheme === "vscode-remote" && authority) return [decoded(authority), `/${decoded(path)}`];
  return null;
}

/** A file URI without the `:42` or `:42:7` after it, and whether it had one. @param {string} uri */
export function withoutPlace(uri) {
  let bare = uri;
  for (let i = 0; i < 2; i++) {
    const m = /^(.*):(\d+)$/.exec(bare);
    if (!m) break;
    bare = m[1];
  }
  return { bare, placed: bare.length !== uri.length };
}

/**
 * The arguments of a new VS Code window on folder `target` with `file` (a
 * file URI, `:line:column` after it) open in it, and the file URI to hand
 * over once the window is up for its line, if it names one. A VS Code that
 * is not running yet quits on `--folder-uri` with `--file-uri` (1.146), so
 * both go as paths, with `--remote` naming a remote folder's machine;
 * `--goto` there would take a remote folder for a file. Null: the file is
 * not on the folder's machine, or not a URI VS Code takes as a path.
 * @param {string} target
 * @param {string} file
 */
export function withFile(target, file) {
  const folder = target.includes("://") ? location(target) : [null, target];
  if (!folder) return null;
  const { bare, placed } = withoutPlace(file);
  const path = location(bare);
  if (!path || path[0] !== folder[0]) return null;
  const args = ["--new-window"];
  if (folder[0] != null) args.push("--remote", folder[0]);
  args.push(folder[1], path[1]);
  return { args, later: placed ? file : null };
}

/**
 * The launch description of a new VS Code window on `target` (a folder URI or
 * a local folder path), with `file` (a file URI, `:line:column` after it)
 * open in it, and the file URI to hand over once the window is up.
 * @param {string} target
 * @param {string | null} file
 * @param {(name: string) => string | null} env
 */
export function vscodeLaunch(target, file, env) {
  target = target.trim();
  if (!target) throw new Error("No folder to open");
  const program = codePrograms(env);
  if (!program.length) throw new Error("VS Code is not installed (set HERDR_VSCODE_EXE to Code.exe)");
  let args = ["--new-window", ...(target.includes("://") ? ["--folder-uri", target] : [target])];
  let later = null;
  if (file) {
    const opened = withFile(target, file);
    if (opened) ({ args, later } = opened);
    else args.push("--goto", "--file-uri", file);
  }
  const name = target.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return {
    description: {
      program, args, class: "Chrome_WidgetWin_1", title: decoded(name),
      missing: "VS Code is not installed (set HERDR_VSCODE_EXE to Code.exe)",
    },
    later,
  };
}

/**
 * When, after VS Code's window was adopted, the files handed to it go again
 * (milliseconds). A new window takes a few seconds to connect to its machine
 * (WSL, SSH): before that it opens a file but drops its line (VS Code 1.146),
 * and the files come to front in no fixed order. Its title is no sign of it:
 * it names a file before the window has connected.
 */
export const HAND_AGAIN = [3000, 8000, 15000];

/** The `HAND_AGAIN` rounds already past for a window adopted at `at`. @param {number} at @param {number} now */
export function roundsPast(at, now) {
  return HAND_AGAIN.filter((after) => at + after <= now).length;
}
