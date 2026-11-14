// VS Code URIs of folders and files on the machines Herdr knows. A machine's
// route comes from the home folder's machines.json: `editorAuthority`
// (`wsl+<distro>` or `ssh-remote+<host>`), else `ssh-remote+<target>`.

/** @param {string} path */
function encodedPath(path) {
  return path.split("/").map((part, index) =>
    index === 1 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)
  ).join("/");
}

/** @param {string} path */
function absolutePath(path) {
  if (/^[a-z]:[\\/]/i.test(path)) return "/" + path.replaceAll("\\", "/");
  if (path.startsWith("/")) return path;
  throw new Error(`Expected an absolute path, not ${path}.`);
}

/**
 * The VS Code URI of a folder or file on a machine (null: this computer).
 * @param {string} path
 * @param {string | null} machine
 * @param {{name: string, target: string, editorAuthority?: string}[]} machines
 */
export function editorUri(path, machine, machines) {
  if (!path) throw new Error("No folder to open.");
  if (machine == null) {
    const unc = /^\\\\([^\\]+)\\(.+)$/.exec(path);
    if (unc) return `file://${unc[1]}/${encodedPath(unc[2].replaceAll("\\", "/"))}`;
    if (!/^[a-z]:[\\/]/i.test(path)) throw new Error(`Expected a local Windows path, not ${path}.`);
    return "file://" + encodedPath(absolutePath(path));
  }
  const route = machines.find((m) => m.name === machine);
  if (!route) throw new Error(`machines.json has no route to ${machine} for VS Code.`);
  const authority = route.editorAuthority ?? `ssh-remote+${route.target}`;
  if (!/^(wsl|ssh-remote)\+[a-z0-9_.-]+$/i.test(authority)) throw new Error(`Invalid editorAuthority for ${machine}.`);
  if (authority.startsWith("wsl+")) {
    const mount = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(path);
    if (mount) return `file:///${mount[1].toUpperCase()}:/${encodedPath(mount[2] ?? "")}`;
  }
  return `vscode-remote://${authority}${encodedPath(absolutePath(path))}`;
}

/** Where in a file VS Code's --goto puts the cursor: `:42`, `:42:7` or nothing. @param {{line?: number | null, column?: number | null}} link */
export function place(link) {
  if (!link.line) return "";
  return link.column ? `:${link.line}:${link.column}` : `:${link.line}`;
}

/** The folder a file is in. @param {string} path */
export function parentFolder(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut <= 0) return path.startsWith("/") ? "/" : path;
  const folder = path.slice(0, cut);
  return /^[a-z]:$/i.test(folder) ? `${folder}\\` : folder;
}

/** Whether `path` is `folder` or inside it. @param {string} path @param {string} folder */
export function inside(path, folder) {
  const norm = (/** @type {string} */ p) => p.replaceAll("\\", "/").replace(/\/+$/, "");
  const [p, f] = [norm(path), norm(folder)];
  return p === f || p.startsWith(`${f}/`);
}

/**
 * What a VS Code app in a pane opens: the folder (its URI) and, for a file
 * link, the file to show (its URI with the line). A folder link is that
 * folder; a file link opens in the pane's project when it is in it, else in
 * its own folder; without a link, the pane's project.
 * @param {{link?: any, project?: {folder: string, machine: string | null}}} props
 * @param {{name: string, target: string, editorAuthority?: string}[]} machines
 */
export function appTarget(props, machines) {
  const { link, project } = props;
  if (link?.kind === "folder") return { folder: editorUri(link.path, link.machine ?? null, machines), goto: null };
  if (link?.kind === "file") {
    const machine = link.machine ?? null;
    const sameProject = project && (project.machine ?? null) === machine && inside(link.path, project.folder);
    const folder = sameProject ? project.folder : parentFolder(link.path);
    return { folder: editorUri(folder, machine, machines), goto: editorUri(link.path, machine, machines) + place(link) };
  }
  if (!project?.folder) throw new Error("No project folder to open.");
  return { folder: editorUri(project.folder, project.machine ?? null, machines), goto: null };
}
