import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, release } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const wsl = process.platform === 'linux' && /microsoft/i.test(release());
// Keep imports native; Pi's TypeScript loader otherwise caches dependencies on /reload.
export function importFresh(url) { return import(url); }
export async function runJson(command, args, options = {}) {
  const { stdout } = await execute(command, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...options });
  let value;
  try { value = JSON.parse(stdout); }
  catch { throw new Error(`${path.basename(command)} returned a non-JSON result; inspect the running app before retrying a mutation`); }
  if (value?.error) throw new Error(typeof value.error === 'string' ? value.error : JSON.stringify(value.error));
  return value;
}
export async function resolveApp() {
  if (process.env.HERDR_APP_BIN) return process.env.HERDR_APP_BIN;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Programs', 'herdr-app', 'herdr-app.exe');
  if (wsl) {
    const absolute = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    const powershell = process.env.HERDR_WINDOWS_POWERSHELL || await access(absolute).then(() => absolute, () => 'powershell.exe');
    const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("LocalApplicationData")'], { timeout: 10000, windowsHide: true });
    return (await execute('wslpath', ['-u', path.win32.join(stdout.trim(), 'Programs', 'herdr-app', 'herdr-app.exe')], { timeout: 5000 })).stdout.trim();
  }
  return 'herdr-app';
}

// The unframed core API is JSON-RPC over one hc connection. Metadata calls do
// not need framed terminal streams, a local App executable or an SSH tunnel.
// Direct Pi launches do not load a shell profile; include hc's standard install paths.
export function resolveHc({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  if (env.HC_BIN) return env.HC_BIN;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const name = platform === 'win32' ? 'hc.exe' : 'hc';
  const directories = [...(env.PATH || '').split(platform === 'win32' ? ';' : ':'), paths.join(home, '.local', 'bin'), ...(platform === 'win32' ? [paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'Programs', 'herdr-core')] : [])];
  return directories.filter(Boolean).map(directory => paths.join(directory, name)).find(file => existsSync(file)) || 'hc';
}
export class CoreRpc {
  constructor() {
    this.next = 0; this.pending = new Map(); this.buffer = ''; this.closed = false;
    this.child = spawn(resolveHc(), ['connect'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const fail = () => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('Core connection closed; the request effect is unknown. Inspect Herdr before retrying.')); }
      this.pending.clear();
    };
    this.child.on('error', fail); this.child.on('exit', fail);
    this.child.stdin.on('error', fail); this.child.stderr.resume();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) { this.close(); fail(); return; }
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        let reply;
        try { reply = JSON.parse(line); } catch { this.close(); fail(); return; }
        const pending = this.pending.get(reply.id);
        if (!pending) continue;
        this.pending.delete(reply.id); clearTimeout(pending.timer);
        if (reply.error) pending.reject(Object.assign(new Error(reply.error.message || 'Core request failed'), { code: reply.error.data?.kind ?? reply.error.code }));
        else pending.resolve(reply.result);
      }
    });
    this.ready = this.rawCall('hello', {});
  }
  rawCall(method, params) {
    if (this.closed) return Promise.reject(new Error('Core connection is closed; request not sent'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Core request timed out; its effect is unknown. Inspect Herdr before retrying.')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async call(method, params) { await this.ready; return this.rawCall(method, params); }
  close() { this.child.stdin.end(); }
}

const validRoute = route => route?.version === 1 && typeof route.app === 'string' && route.app && typeof route.epoch === 'string' && route.epoch && /^[a-z0-9][a-z0-9_.-]{0,31}$/.test(route.mailbox);
const document = (value, epoch) => value?.version === 1 && value.epoch === epoch && value.requests && typeof value.requests === 'object' && !Array.isArray(value.requests) ? value : { version: 1, epoch, requests: {} };
const conflict = error => error.code === 'conflict';
export async function requestViaMailbox(core, route, identity, wire, { timeout = 15000, pollMs = 250 } = {}) {
  if (!validRoute(route)) throw new Error('The initiating Herdr App route is missing or invalid. Update Herdr and reload this Pi.');
  const id = randomUUID(), expires = Date.now() + Math.min(timeout, 120000);
  const request = { pid: identity.pid, session: identity.session, expires, state: 'ready', wire };
  let admitted = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await core.call('doc.get', { name: route.mailbox });
    const value = structuredClone(document(current.value, route.epoch));
    for (const [key, entry] of Object.entries(value.requests)) if (entry.expires < Date.now()) delete value.requests[key];
    if (Object.keys(value.requests).length >= 8) throw new Error('The App mailbox has eight pending requests. Inspect Herdr before sending more.');
    value.requests[id] = request;
    if (Buffer.byteLength(JSON.stringify(value)) > 900000) throw new Error('The App request exceeds the bounded mailbox size');
    try { await core.call('doc.set', { name: route.mailbox, version: current.version, value }); admitted = true; break; }
    catch (error) { if (!conflict(error)) throw error; }
  }
  if (!admitted) throw new Error('The App mailbox changed repeatedly; no request was submitted');
  await core.call('terminal.label', { terminal: identity.terminal, labels: { 'herdr.app.request': id } });
  do {
    const current = await core.call('doc.get', { name: route.mailbox });
    if (current.value?.epoch !== route.epoch) throw new Error('The App restarted or its route changed; this request effect is unknown. Inspect it before retrying.');
    const result = current.value.requests?.[id];
    if (!result) throw new Error('The App request receipt is unavailable; its effect is unknown. Inspect Herdr before retrying.');
    if (result.state === 'done') {
      // Only acknowledge after observing the result. Failure to prune cannot
      // invalidate a confirmed result, and unknown writes are never replayed.
      try {
        const value = structuredClone(current.value); delete value.requests[id];
        await core.call('doc.set', { name: route.mailbox, version: current.version, value });
      } catch { /* Retain the bounded result until its expiry. */ }
      if (result.result?.error) throw new Error(typeof result.result.error === 'string' ? result.result.error : JSON.stringify(result.result.error));
      return result.result;
    }
    await delay(pollMs);
  } while (Date.now() < expires);
  throw new Error('The App did not confirm this request before its deadline; its effect is unknown. Inspect Herdr before retrying.');
}
export class AppClient {
  constructor(bindOrigin, pid, session) { this.bindOrigin = bindOrigin; this.pid = pid; this.session = session; this.hc = resolveHc(); }
  async app(args, options = {}) {
    const owner = await this.owner();
    let route;
    try { route = JSON.parse(owner.labels?.['herdr.app'] ?? 'null'); } catch { /* Report an invalid route below. */ }
    if (!validRoute(route)) throw new Error('The initiating Herdr App route is missing or invalid. Update Herdr and reload this Pi.');
    const wire = args[0] === 'ls' ? { ls: true } : { do: args[1], args: JSON.parse(args[2] ?? '{}') };
    const core = new CoreRpc();
    try { return await requestViaMailbox(core, route, { pid: this.pid, session: this.session, terminal: process.env.HC_TERMINAL_ID }, wire, options); }
    finally { core.close(); }
  }
  async command(name, args = {}) {
    const launch = ['space.new', 'tab.new', 'pane.split', 'terminal.open'].includes(name);
    return this.app(['do', name, JSON.stringify(args)], { timeout: launch ? 100000 : name.startsWith('agent.') ? 35000 : 15000 });
  }
  async owner() {
    if (!process.env.HC_TERMINAL_ID || !process.env.HC_TERMINAL_SOCKET) throw new Error('Run this Pi in a Herdr App terminal; HC terminal identity is missing');
    const terminal = await runJson(this.hc, ['get', process.env.HC_TERMINAL_ID, '--json']);
    if (terminal.foreground?.pid !== this.pid) throw new Error('This Pi is not the Herdr terminal foreground process');
    return terminal;
  }
  async context() {
    const terminal = await this.owner();
    return this.bindOrigin(await this.app(['ls']), terminal, this.pid, this.session);
  }
  async publish(label) {
    await this.owner();
    return runJson(this.hc, ['label', process.env.HC_TERMINAL_ID, `herdr.pi=${JSON.stringify(label)}`, '--json']);
  }
  async workflow() { return this.command('workflow.get'); }
  async list(args) {
    const [agents, workflow] = await Promise.all([this.command('agent.list', args), this.workflow()]);
    return { ...agents, workflow };
  }
  async inspect(terminal, lines = 40, screen = true) { return this.command('agent.inspect', { terminal, lines, screen }); }
  async send(input) { return this.command('agent.send', input); }
  async stop(input) { return this.command('agent.stop', input); }
  async remove(input) {
    const { terminal, pid, session } = input;
    return this.command('agent.remove', { terminal, pid, session });
  }
  async launch(input) {
    const origin = await this.context();
    const common = { folder: input.folder, argv: ['pi', '--model', input.model, '--thinking', input.thinking], task: input.message, focus: false };
    if (input.space || !input.newSpace) {
      const space = input.space || origin.space;
      const result = await this.command('tab.new', { ...common, space, name: input.name });
      return { ...result, space: result.space || space };
    }
    return this.command('space.new', { ...common, name: input.newSpace.name, tab: input.name, machine: input.newSpace.machine ?? origin.machine ?? '' });
  }
}
