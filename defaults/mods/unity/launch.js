// How Herdr starts the Unity Editor for a pane: the editor version the
// project names, from Unity Hub's editor folders.

/**
 * The editor version a Unity project is bound to: `m_EditorVersion` of its
 * `ProjectSettings/ProjectVersion.txt`; null when it names none.
 * @param {string} projectVersion
 */
export function editorVersion(projectVersion) {
  for (const line of projectVersion.split(/\r?\n/)) {
    const m = /^\s*m_EditorVersion:(.*)$/.exec(line);
    if (m) return m[1].trim() || null;
  }
  return null;
}

/**
 * The folders Unity Hub installs editors in, each holding a `<version>`
 * folder per editor: the one chosen in the Hub's settings
 * (`%APPDATA%\UnityHub\secondaryInstallPath.json`, a JSON string), then its
 * default.
 * @param {(name: string) => string | null} env
 * @param {string | null} secondaryInstallPath that file's text, null when absent
 */
export function unityRoots(env, secondaryInstallPath) {
  let chosen = null;
  try {
    const value = JSON.parse((secondaryInstallPath ?? "").replace(/^\uFEFF/, ""));
    if (typeof value === "string" && value) chosen = value;
  } catch { /* No choice in the Hub. */ }
  const programs = env("ProgramFiles");
  return [chosen, programs && `${programs}\\Unity\\Hub\\Editor`].filter((p) => typeof p === "string" && p !== "");
}

/**
 * The launch description of the Unity Editor on the project in `folder` (a
 * Windows path). Unity locks a project: an editor already on it is adopted
 * (`once`, by the project folder's name in its title). Its main window keeps
 * its menu bar, and its first start imports every asset: that may take many
 * minutes.
 * @param {string} folder
 * @param {string} version
 * @param {string[]} roots
 */
export function unityLaunch(folder, version, roots) {
  const missing = `Unity ${version} is not installed: install it with Unity Hub`;
  if (!roots.length) throw new Error(missing);
  const title = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return {
    program: roots.map((root) => `${root}\\${version}\\Editor\\Unity.exe`),
    args: ["-projectPath", folder],
    class: "UnityContainerWndClass",
    title,
    ownProcess: true,
    once: true,
    menuWindow: true,
    wait: 30 * 60,
    missing,
  };
}

/**
 * A project folder on this computer's drives as a Windows path: a path, or
 * a `file://` URI; null for anything else.
 * @param {string} target
 */
export function localFolder(target) {
  target = target.trim();
  if (target.startsWith("file://")) {
    const rest = target.slice("file://".length);
    let path = rest;
    try { path = decodeURIComponent(rest); } catch { /* As written. */ }
    const drive = /^\/?([a-z]:)(\/.*)?$/i.exec(path);
    if (drive) target = `${drive[1]}${(drive[2] ?? "\\").replaceAll("/", "\\")}`;
    else if (path && !path.startsWith("/")) target = `\\\\${path.replaceAll("/", "\\")}`;
    else return null;
  }
  if (!/^[a-z]:[\\/]/i.test(target) && !target.startsWith("\\\\")) return null;
  while (target.length > 3 && /[\\/]$/.test(target)) target = target.slice(0, -1);
  return target;
}
