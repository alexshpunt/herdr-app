import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// hc's path. A Pi started without a login shell (Herdr's `tab.new {argv}` in
// WSL) has no ~/.local/bin on PATH: look in hc's standard install folders too.
export function resolveHc({ env = process.env, home = homedir(), platform = process.platform, exists = existsSync } = {}) {
    if (env.HC_BIN) return env.HC_BIN;
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const name = platform === 'win32' ? 'hc.exe' : 'hc';
    const directories = [
        ...(env.PATH ?? '').split(platform === 'win32' ? ';' : ':'),
        paths.join(home, '.local', 'bin'),
        ...(platform === 'win32' ? [paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'Programs', 'herdr-core')] : []),
    ];
    return directories.filter(Boolean).map(directory => paths.join(directory, name)).find(file => exists(file)) ?? 'hc';
}
