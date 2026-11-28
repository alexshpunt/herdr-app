import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, release } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RecoveryJournal, receiptName } from './recovery.mjs';

// Pi normally clamps unsupported thinking and may fuzzy-resolve model ids.
// A workflow must either launch its saved selection exactly or fail startup.
export function workflowSelectionError(requestedModel, requestedThinking, model, thinking) {
  if (requestedModel && (!model || `${model.provider}/${model.id}` !== requestedModel)) {
    return `Workflow model ${requestedModel} is unavailable on this machine (Pi selected ${model ? `${model.provider}/${model.id}` : 'no model'}). Choose an installed provider/model or configure a startup fallback.`;
  }
  if (requestedThinking && requestedThinking !== thinking) {
    return `Workflow thinking ${requestedThinking} is unavailable for ${requestedModel ?? `${model?.provider}/${model?.id}`} on this machine (Pi supports ${thinking} for this selection). Choose another level or configure a startup fallback.`;
  }
}
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
export async function requestViaMailbox(core, route, identity, wire, { timeout = 15000, pollMs = 250, prepareReceipt, onAdmitted } = {}) {
  if (!validRoute(route)) throw new Error('The initiating Herdr App route is missing or invalid. Update Herdr and reload this Pi.');
  const id = randomUUID(), lifetime = Math.min(timeout, 120000);
  const receipt = prepareReceipt ? await prepareReceipt(id) : undefined;
  const admissionDeadline = Date.now() + lifetime;
  // The bridge does not propagate cancellation. Never leave a mutation queued
  // for later dispatch after its caller may have stopped waiting.
  const readOnly = wire.ls === true || ['workflow.get', 'agent.list', 'agent.inspect', 'agent.history'].includes(wire.do);
  let expires, admitted = false;
  do {
    const current = await core.call('doc.get', { name: route.mailbox });
    if (Date.now() >= admissionDeadline) break;
    const value = structuredClone(document(current.value, route.epoch));
    for (const [key, entry] of Object.entries(value.requests)) if (entry.expires < Date.now()) delete value.requests[key];
    if (Object.keys(value.requests).length < 8) {
      expires = Date.now() + lifetime;
      value.requests[id] = { pid: identity.pid, session: identity.session, expires, state: 'ready', wire, ...(receipt ? { receipt } : {}) };
      if (Buffer.byteLength(JSON.stringify(value)) > 900000) throw new Error('The App request exceeds the bounded mailbox size');
      try { await core.call('doc.set', { name: route.mailbox, version: current.version, value }); admitted = true; break; }
      catch (error) { if (!conflict(error)) throw error; }
    }
    if (!readOnly) break;
    if (Date.now() < admissionDeadline) await delay(Math.max(1, Math.min(pollMs, admissionDeadline - Date.now())));
  } while (Date.now() < admissionDeadline);
  if (!admitted) throw Object.assign(new Error('The Herdr App request queue remained full or busy. This request was not submitted. Wait for other Herdr calls to finish, then retry. Inspect the effects of any earlier unconfirmed mutation before retrying it.'), { code: 'HERDR_NOT_SUBMITTED', effect: 'not-applied', reason: 'queue' });
  onAdmitted?.();
  await core.call('terminal.label', { terminal: identity.terminal, labels: { 'herdr.app.request': id } });
  do {
    const current = await core.call('doc.get', { name: route.mailbox });
    if (current.value?.epoch !== route.epoch) throw new Error('The App restarted or its route changed; this request effect is unknown. Inspect it before retrying.');
    const result = current.value.requests?.[id];
    if (!result) throw new Error('The App request receipt is unavailable; its effect is unknown. Inspect Herdr before retrying.');
    if (result.state === 'done') {
      // Acknowledge only the observed result. Retry explicit CAS conflicts with
      // a fresh document, preserving every other caller's in-flight request.
      // An unknown write is not retried and cannot invalidate this result.
      let snapshot = current;
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const value = structuredClone(snapshot.value); delete value.requests[id];
          await core.call('doc.set', { name: route.mailbox, version: snapshot.version, value });
          break;
        } catch (error) {
          if (!conflict(error) || attempt === 7) break;
          try { snapshot = await core.call('doc.get', { name: route.mailbox }); }
          catch { break; }
          if (snapshot.value?.epoch !== route.epoch || snapshot.value.requests?.[id]?.state !== 'done') break;
        }
      }
      if (result.result?.error) {
        const error = new Error(typeof result.result.error === 'string' ? result.result.error : JSON.stringify(result.result.error));
        if (result.result.code === 'HERDR_RECEIPT_REFUSED' && result.result.effect === 'not-applied') Object.assign(error, { code: 'HERDR_NOT_SUBMITTED', effect: 'not-applied', reason: 'storage', refusedRequestId: id });
        throw error;
      }
      return result.result;
    }
    await delay(pollMs);
  } while (Date.now() < expires);
  throw new Error('The App did not confirm this request before its deadline; its effect is unknown. Inspect Herdr before retrying.');
}
// A nested Pi, such as one behind a wrapper shell, inherits the HC identity of a
// terminal whose root and foreground processes are someone else.
export function ownsTerminal(terminal, pid) { return terminal?.pid === pid || terminal?.foreground?.pid === pid; }
export class AppClient {
  constructor(bindOrigin, pid, session, { recoveryRoot, coreFactory = () => new CoreRpc() } = {}) {
    this.bindOrigin = bindOrigin; this.pid = pid; this.session = session; this.hc = resolveHc(); this.coreFactory = coreFactory;
    this.tracking = new AsyncLocalStorage();
    this.journal = recoveryRoot ? new RecoveryJournal(recoveryRoot, session) : undefined;
  }
  async tracked(operation, toolCallId, run) {
    if (!this.journal) throw new Error('Recovery is unavailable');
    let id;
    try { id = await this.journal.begin(operation, toolCallId); }
    catch (error) { throw Object.assign(new Error(`Cannot record the request before submission: ${error.message}`), { code: 'HERDR_NOT_SUBMITTED', effect: 'not-applied', reason: 'storage' }); }
    const tracker = { id, operation, admittedMutation: 0 };
    return this.tracking.run(tracker, async () => {
      let result;
      try {
        result = await run();
        await this.journal.complete(id, result);
      } catch (error) {
        const safe = error?.code === 'HERDR_NOT_SUBMITTED' && !tracker.admittedMutation;
        const failure = { code: safe ? 'HERDR_NOT_SUBMITTED' : 'HERDR_OUTCOME_UNKNOWN', effect: safe ? 'not-applied' : 'unknown', ...(safe && error.reason ? { reason: error.reason } : {}), message: error?.message ?? String(error), requestId: id };
        try {
          await this.journal.fail(id, failure);
          const saved = (await this.journal.list()).find(item => item.id === id);
          if (safe) failure.revision = saved?.revision;
          else if (saved?.state === 'result') this.journal.created.delete(id);
        } catch (journalError) { failure.message += `; recovery journal update failed: ${journalError.message}`; }
        finally { this.journal.active.delete(id); }
        throw Object.assign(new Error(failure.message), failure);
      }
      try {
        const entry = (await this.journal.list()).find(item => item.id === id);
        if (!entry || entry.state !== 'result') throw new Error('Recorded recovery result is unavailable');
        return { id, revision: entry.revision, result };
      } catch (error) {
        this.journal.created.delete(id);
        throw Object.assign(new Error(`Result was recorded but could not be delivered: ${error.message}`), { code: 'HERDR_OUTCOME_UNKNOWN', effect: 'unknown', requestId: id });
      }
    });
  }
  async resolveReceipts(requests, existingCore) {
    const core = existingCore ?? this.coreFactory();
    try {
      return await Promise.all(requests.map(async request => {
        if (request.refused) return { id: request.id, state: 'done', result: { code: 'HERDR_RECEIPT_REFUSED', effect: 'not-applied', error: 'App refused an unverifiable receipt' } };
        const response = await core.call('doc.get', { name: request.receipt });
        const value = response.value;
        if (!value || value.id !== request.id || value.session !== this.session) return { id: request.id, state: 'unknown' };
        return { id: request.id, state: value.state, ...(value.state === 'done' ? { result: value.result } : {}) };
      }));
    } finally { if (!existingCore) core.close(); }
  }
  async recoveryList() {
    await this.owner();
    let core;
    try { return await this.journal.list(requests => this.resolveReceipts(requests, core ??= this.coreFactory())); }
    finally { core?.close(); }
  }
  async recoveryAck(input) {
    await this.owner();
    await this.journal.ack(input, requests => this.resolveReceipts(requests));
    const requests = await this.journal.cleanupPending();
    if (!requests.length) return { cleanupPending: [] };
    const core = this.coreFactory(), cleanupPending = [];
    try {
      for (const request of requests) {
        try {
          const current = await core.call('doc.get', { name: request.receipt });
          if (current.value != null) {
            if (current.value.id !== request.id || current.value.session !== this.session) throw new Error('Receipt identity changed');
            await core.call('doc.set', { name: request.receipt, version: current.version, value: null });
          }
          await this.journal.cleanupComplete(request.id);
        } catch (error) { cleanupPending.push({ id: request.id, error: error.message }); }
      }
    } finally { core.close(); }
    return { cleanupPending };
  }
  async app(args, options = {}) {
    const owner = await this.owner();
    let route;
    try { route = JSON.parse(owner.labels?.['herdr.app'] ?? 'null'); } catch { /* Report an invalid route below. */ }
    if (!validRoute(route)) throw new Error('The initiating Herdr App route is missing or invalid. Update Herdr and reload this Pi.');
    const wire = args[0] === 'ls' ? { ls: true } : { do: args[1], args: JSON.parse(args[2] ?? '{}') };
    const core = this.coreFactory(), tracker = this.tracking.getStore();
    const readOnly = wire.ls === true || ['workflow.get', 'agent.list', 'agent.inspect', 'agent.history'].includes(wire.do);
    const capture = tracker && (!readOnly || wire.do === tracker.operation);
    try {
      if (capture && route.receipts !== 1) throw Object.assign(new Error('Update Herdr App before using durable recovery.'), { code: 'HERDR_NOT_SUBMITTED', effect: 'not-applied', reason: 'app-version' });
      const prepareReceipt = capture ? async id => {
        const receipt = receiptName(id);
        await this.journal.addRequest(tracker.id, { id, receipt, wire });
        try { await core.call('doc.set', { name: receipt, version: 0, value: { version: 1, id, pid: this.pid, session: this.session, state: 'pending' } }); }
        catch (error) { throw Object.assign(new Error(`Cannot prepare durable App receipt: ${error.message}`), { code: 'HERDR_NOT_SUBMITTED', effect: 'not-applied', reason: 'storage' }); }
        return receipt;
      } : undefined;
      try {
        return await requestViaMailbox(core, route, { pid: this.pid, session: this.session, terminal: process.env.HC_TERMINAL_ID }, wire, { ...options, prepareReceipt, onAdmitted: () => { if (tracker && !readOnly) tracker.admittedMutation++; } });
      } catch (error) {
        if (tracker && error?.refusedRequestId) {
          await this.journal.preserveReceipt(tracker.id, error.refusedRequestId);
          if (!readOnly) tracker.admittedMutation--;
        }
        throw error;
      }
    } finally { core.close(); }
  }
  async command(name, args = {}) {
    const launch = ['space.new', 'tab.new', 'pane.split', 'terminal.open'].includes(name);
    return this.app(['do', name, JSON.stringify(args)], { timeout: launch ? 100000 : name.startsWith('agent.') ? 35000 : 15000 });
  }
  async terminal() {
    if (!process.env.HC_TERMINAL_ID || !process.env.HC_TERMINAL_SOCKET) throw new Error('Run this Pi in a Herdr App terminal; HC terminal identity is missing');
    return runJson(this.hc, ['get', process.env.HC_TERMINAL_ID, '--json']);
  }
  async owner() {
    const terminal = await this.terminal();
    if (!ownsTerminal(terminal, this.pid)) throw new Error('This Pi is not the Herdr terminal foreground process');
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
  async inspect(terminal, lines = 40, screen) { return this.command('agent.inspect', { terminal, lines, screen }); }
  // Every agent gets a space of its own, named after it, so it does not crowd
  // the caller's tab bar. Only a startup fallback joins its primary's space.
  async launch(input) {
    const depth = input.depth ? ['--herdr-depth', String(input.depth)] : [];
    const common = { folder: input.folder, argv: ['pi', '--model', input.model, '--thinking', input.thinking, '--herdr-workflow-model', input.model, '--herdr-workflow-thinking', input.thinking, ...depth], task: input.message, focus: false };
    if (input.space) {
      const result = await this.command('tab.new', { ...common, space: input.space, name: input.name });
      return { ...result, space: result.space || input.space };
    }
    const origin = await this.context();
    return this.command('space.new', { ...common, name: input.name, tab: input.name, machine: input.machine ?? origin.machine ?? '' });
  }
  // A replica of the calling Pi opens its prepared session copy in a new tab of
  // the caller's space. The bridge launches only Pi, never an arbitrary argv.
  async replicate(input = {}) {
    for (const key of ['name', 'session', 'folder', 'model', 'task']) {
      if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`agent.replicate needs a non-empty ${key}`);
    }
    const absolute = /^(\/|[A-Za-z]:[\\/]|\\\\)/;
    if (!absolute.test(input.folder)) throw new Error('agent.replicate needs an absolute folder');
    if (!absolute.test(input.session) || !input.session.endsWith('.jsonl')) throw new Error('agent.replicate needs an absolute .jsonl session file');
    if (input.thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(input.thinking)) throw new Error('agent.replicate got an unknown thinking level');
    if (input.depth !== undefined && !(Number.isSafeInteger(input.depth) && input.depth > 0)) throw new Error('agent.replicate got an invalid depth');
    const origin = await this.context();
    const argv = ['pi', '--session', input.session, '--model', input.model, ...(input.thinking ? ['--thinking', input.thinking] : []),
      ...(input.depth ? ['--herdr-depth', String(input.depth)] : [])];
    const result = await this.command('tab.new', { space: origin.space, name: input.name, folder: input.folder, argv, task: input.task, focus: false });
    return { ...result, space: result.space || origin.space };
  }
}
