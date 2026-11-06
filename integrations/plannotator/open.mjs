#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const wsl = process.platform === 'linux' && /microsoft/i.test(release());
export const reviewKey = (session, url) => createHash('sha256').update(JSON.stringify([session, url])).digest('hex');
const stateDir = () => process.env.HERDR_PLANNOTATOR_STATE_DIR || path.join(tmpdir(), 'herdr-plannotator', String(process.getuid?.() ?? 'user'));
const recordPath = (session, url) => path.join(stateDir(), reviewKey(session, url));
const exists = async file => access(file).then(() => true, () => false);

export function findOriginPane(snapshot, terminal) {
    const spaceId = terminal.labels?.['herdr.space'];
    if (!spaceId || !terminal.address) return undefined;
    const matches = [];
    for (const space of snapshot.spaces ?? []) {
        if (space.id !== spaceId && !space.id.endsWith(`/${spaceId}`)) continue;
        for (const tab of space.tabs ?? []) {
            for (const item of tab.terminals ?? []) {
                if ((item.terminal === terminal.address || item.terminal.endsWith(`/${terminal.address}`)) && typeof item.pane === 'string') matches.push(item.pane);
            }
        }
    }
    return matches.length === 1 ? matches[0] : undefined;
}

export async function runJson(command, args) {
    const { stdout } = await execute(command, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const value = JSON.parse(stdout);
    if (value.error) throw new Error(value.error);
    return value;
}

async function powershell() {
    if (process.env.HERDR_WINDOWS_POWERSHELL) return process.env.HERDR_WINDOWS_POWERSHELL;
    if (wsl) {
        const absolute = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
        if (await exists(absolute)) return absolute;
    }
    return 'powershell.exe';
}

export async function resolveApp() {
    if (process.env.HERDR_APP_BIN) return process.env.HERDR_APP_BIN;
    if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Programs', 'herdr-app', 'herdr-app.exe');
    if (wsl) {
        const { stdout } = await execute(await powershell(), ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("LocalApplicationData")'], { timeout: 10000, windowsHide: true });
        const windows = path.win32.join(stdout.trim(), 'Programs', 'herdr-app', 'herdr-app.exe');
        return (await execute('wslpath', ['-u', windows], { timeout: 5000 })).stdout.trim();
    }
    return 'herdr-app';
}

export async function openExternal(url) {
    if (process.platform === 'win32' || wsl) {
        const env = { ...process.env, HERDR_PLANNOTATOR_URL: url };
        if (wsl) env.WSLENV = [env.WSLENV, 'HERDR_PLANNOTATOR_URL'].filter(Boolean).join(':');
        await execute(await powershell(), ['-NoProfile', '-NonInteractive', '-Command', 'Set-Location $env:SystemRoot; Start-Process -FilePath $env:HERDR_PLANNOTATOR_URL -ErrorAction Stop'], { env, timeout: 15000, windowsHide: true });
    } else {
        await execute(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { timeout: 15000 });
    }
}

export async function openReview(url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Expected an HTTP(S) URL without credentials');
    const session = process.env.HERDR_PLANNOTATOR_SESSION_ID;
    const terminalId = process.env.HC_TERMINAL_ID;
    if (!session || !terminalId || process.env.HERDR_PLANNOTATOR_MODE === 'external') {
        await openExternal(url);
        return { kind: 'external' };
    }
    const record = recordPath(session, url);
    await mkdir(stateDir(), { recursive: true, mode: 0o700 });
    if (await exists(`${record}.closed`)) return { kind: 'closed' };
    try {
        const app = await resolveApp();
        const api = await runJson(app, ['--browser-api']);
        if (api.version !== 1 || api.module !== 'herdr-browser') throw new Error('The installed Herdr App has no native browser API');
        const [terminal, snapshot] = await Promise.all([
            runJson(process.env.HC_BIN || 'hc', ['get', terminalId, '--json']),
            runJson(app, ['ls']),
        ]);
        const origin = findOriginPane(snapshot, terminal);
        if (!origin) throw new Error('The requesting terminal has no unambiguous pane in this Herdr App');
        const result = await runJson(app, ['do', 'pane.split', JSON.stringify({ direction: 'right', pane: origin, mod: 'plannotator-browser', props: { url, session, origin: terminalId, review: reviewKey(session, url) } })]);
        if (typeof result.pane !== 'string') throw new Error('Herdr did not return the new browser pane');
        const value = { app, pane: result.pane, session, url };
        const temporary = `${record}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
        await rename(temporary, `${record}.json`);
        if (await exists(`${record}.closed`)) await runJson(app, ['do', 'pane.close', JSON.stringify({ pane: result.pane })]);
        return { kind: 'embedded', pane: result.pane };
    } catch (error) {
        // A missing fork/mod/app must never strand the review without a browser.
        console.error(`Herdr browser unavailable: ${error.message}. Opening the system browser.`);
        if (!(await exists(`${record}.closed`))) await openExternal(url);
        return { kind: 'external', reason: error.message };
    }
}

export async function closeReview(session, url) {
    if (!session) return;
    const record = recordPath(session, url);
    await mkdir(stateDir(), { recursive: true, mode: 0o700 });
    // A tombstone also covers a browser helper that has not finished opening.
    await writeFile(`${record}.closed`, '', { mode: 0o600 });
    let value;
    try { value = JSON.parse(await readFile(`${record}.json`, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (value.session !== session || value.url !== url || typeof value.pane !== 'string') throw new Error('Review ownership does not match');
    await runJson(value.app, ['do', 'pane.close', JSON.stringify({ pane: value.pane })]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    openReview(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
