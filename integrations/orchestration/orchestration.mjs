import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function bindOrigin(snapshot, terminal, pid, session) {
  if (terminal.state && terminal.state !== 'live') throw new Error('This Herdr terminal is not live');
  if (terminal.foreground?.pid !== pid) throw new Error('This Pi is not the terminal foreground process; inherited HC context is not sufficient');
  const matches = [];
  const spaceId = terminal.labels?.['herdr.space'];
  for (const space of snapshot.spaces ?? []) {
    if (!spaceId || (space.id !== spaceId && !space.id.endsWith(`/${spaceId}`))) continue;
    for (const tab of space.tabs ?? []) for (const pane of tab.terminals ?? []) {
      if (pane.terminal === terminal.address || pane.terminal?.endsWith(`/${terminal.address}`)) {
        matches.push({ pid, session, terminal: pane.terminal, space: space.id, tab: tab.id, machine: space.machine ?? null });
      }
    }
  }
  if (matches.length !== 1) throw new Error('This Pi has no unambiguous stable placement in the running Herdr App');
  return matches[0];
}

export function startupOutcome(agent) {
  // A successful assistant response, including a tool call, ends startup forever.
  if (agent.startup === 'started') return 'started';
  if (agent.startup === 'failed') return 'model-failed';
  if (agent.status === 'blocked') return 'blocked';
  if (agent.state !== 'live' || agent.exited) return 'exited';
  return 'pending';
}
const hash = value => createHash('sha256').update(value).digest('hex');
const nonempty = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
};
const aborted = signal => { if (signal?.aborted) throw new Error('Operation aborted; inspect the saved receipt before retrying'); };

/** A write-ahead receipt prevents repeated requests from launching duplicate agents after reload. */
export class Orchestrator {
  constructor(client, root, options = {}) {
    this.client = client;
    this.root = root;
    this.pollMs = options.pollMs ?? 1000;
    this.startupMs = options.startupMs ?? 90000;
  }
  async save(file, data) {
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await rename(temp, file);
  }
  async create(input, signal, update = (_data) => {}) {
    aborted(signal);
    for (const key of ['requestId', 'name', 'folder', 'message', 'profile']) nonempty(input[key], key);
    if (input.space && input.newSpace) throw new Error('Give space or newSpace, not both');
    if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(input.folder)) throw new Error('folder must be an absolute path on the target machine');
    const origin = await this.client.context();
    const config = await this.client.workflow();
    const profile = config.profiles?.find(p => p.id === input.profile);
    if (!profile) throw new Error(`Unknown workflow profile ${input.profile}; read workflow.get in Herdr App`);
    const model = nonempty(input.model ?? profile.model, 'model');
    const fallback = input.fallbackModel === null ? undefined : (input.fallbackModel ?? profile.fallbackModel);
    const thinking = input.thinking ?? profile.thinking ?? 'high';
    const key = hash(`${origin.machine ?? ''}\n${input.requestId}`);
    const file = path.join(this.root, `${key}.json`);
    const fingerprint = hash(JSON.stringify(input));
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let receipt = { version: 1, requestId: input.requestId, fingerprint, name: input.name, model, outcome: 'unknown', detail: 'Launch intent saved; the effect is not yet confirmed. Inspect Herdr before using another requestId.', attempts: [] };
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(receipt)); } finally { await handle.close(); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let saved;
      try { saved = JSON.parse(await readFile(file, 'utf8')); }
      catch { throw new Error(`Request ${input.requestId} is being recorded or has an unreadable receipt; inspect Herdr before retrying`); }
      if (saved.fingerprint !== fingerprint) throw new Error(`Request ${input.requestId} already records different inputs; inspect its agent rather than reusing its key`);
      return { ...saved, reused: true };
    }
    const launch = async (chosen, space) => {
      aborted(signal);
      // A new attempt has no confirmed identity until its own launch/observation.
      for (const field of ['terminal', 'tab', 'space', 'pid', 'session']) delete receipt[field];
      receipt.model = chosen;
      receipt.outcome = 'unknown';
      receipt.detail = 'Launch intent saved; inspect Herdr before retrying an unconfirmed launch.';
      await this.save(file, receipt);
      const target = await this.client.launch({ ...input, model: chosen, thinking, space });
      for (const field of ['terminal', 'tab', 'space']) nonempty(target[field], `launch result ${field}`);
      receipt = { ...receipt, ...target, outcome: 'pending', detail: 'Waiting for the first successful assistant response', attempts: [...receipt.attempts, { model: chosen, ...target }] };
      await this.save(file, receipt);
      update({ ...receipt });
      return target;
    };
    const observe = async target => {
      const deadline = Date.now() + this.startupMs;
      do {
        if (signal?.aborted) return { outcome: 'pending', detail: 'Observation cancelled; the agent is left running. Inspect it before further action.' };
        const agent = await this.client.inspect(target.terminal);
        const outcome = startupOutcome(agent);
        if (outcome !== 'pending') return { outcome, pid: agent.pid, session: agent.session, detail: agent.startupError ?? agent.message };
        await delay(this.pollMs, undefined, { signal }).catch(error => { if (!signal?.aborted) throw error; });
      } while (Date.now() < deadline);
      return { outcome: 'pending', detail: 'Startup observation timed out; the agent is left running. Inspect it before retrying.' };
    };
    try {
      let target = await launch(model, input.space);
      let outcome = await observe(target);
      receipt = { ...receipt, ...outcome };
      await this.save(file, receipt);
      if (fallback && fallback !== model && ['model-failed', 'exited'].includes(outcome.outcome) && !signal?.aborted) {
        // The user may have retried the primary after its first error. Re-read
        // it before launching a replacement; a recovered agent stays primary.
        const current = await this.client.inspect(target.terminal);
        outcome = { outcome: startupOutcome(current), pid: current.pid, session: current.session, detail: current.startupError ?? current.message };
        receipt = { ...receipt, ...outcome };
        await this.save(file, receipt);
        if (['model-failed', 'exited'].includes(outcome.outcome) && !signal?.aborted) {
          const failed = { ...target, pid: outcome.pid, session: outcome.session };
          receipt.retainedPrimary = failed;
          target = await launch(fallback, target.space);
          receipt.fallbackUsed = true;
          outcome = await observe(target);
          receipt = { ...receipt, ...outcome };
          // Never remove a primary automatically. It is user-owned and may be
          // resumed while fallback starts; retaining it also preserves evidence.
          await this.save(file, receipt);
        }
      }
    } catch (error) {
      receipt.detail = `${error.message}. Inspect the existing agent before using another requestId.`;
      // A failed observation is not proof that the launch failed.
      if (receipt.outcome !== 'unknown') receipt.outcome = 'pending';
    }
    await this.save(file, receipt);
    return receipt;
  }
  async act(action, input) {
    const origin = await this.client.context();
    if (input.terminal === origin.terminal) throw new Error('Do not manage this Pi through its own Herdr agent tool');
    const agent = await this.client.inspect(input.terminal);
    if (!input.pid || !input.session || agent.pid !== input.pid || agent.session !== input.session) throw new Error('The agent identity changed or is unavailable; inspect it and use its current PID and session');
    if (action === 'send' && agent.status === 'blocked') throw new Error('The agent is blocked on a user question; let the user answer it instead of bypassing the prompt');
    if (action === 'send' && agent.startup !== 'started') throw new Error('The agent has not completed startup; give its first message through create and inspect its startup state');
    const observed = await this.client[action](input);
    return { action, terminal: input.terminal, pid: input.pid, session: input.session, outcome: action === 'send' ? 'submitted' : 'unconfirmed', ...observed };
  }
}
