// Explicit, opt-in native App verification. Requires an isolated App/core,
// the live-provider fixture and a running fixture controller; no model service.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.match(config.coreSession, /^test-/);
assert.ok(config.appHome && config.exe && config.folder && config.trace && config.controller);
const env = { ...process.env, HC_SESSION: config.coreSession, HERDR_APP_HOME: config.appHome };
const stamp = Date.now().toString(36), reports = [];
function app(command, args) {
  const argv = command === 'ls' ? ['ls'] : ['do', command, JSON.stringify(args ?? {})];
  const result = spawnSync(config.exe, argv, { encoding: 'utf8', env, timeout: 105000 });
  assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`);
  const value = JSON.parse(result.stdout);
  assert.ok(!value.error, `${command}: ${value.error}`);
  return value;
}
async function trace() {
  const source = await readFile(config.trace, 'utf8');
  // A running producer may not yet have ended its final line.
  return source.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
}
async function waitFor(probe, timeout = 45000) {
  const until = Date.now() + timeout;
  do { const result = await probe(); if (result) return result; await delay(250); } while (Date.now() < until);
  throw new Error('Native fixture did not reach the expected state before its deadline');
}
const controller = app('agent.inspect', { terminal: config.controller, lines: 0, screen: false });
assert.equal(controller.identityCurrent, true);
assert.equal(controller.startup, 'started');
async function invoke(name, args, expectError = false) {
  const offset = (await trace()).length;
  const sent = app('agent.send', { terminal: controller.terminal, pid: controller.pid, session: controller.session, message: JSON.stringify({ name, arguments: args }) });
  assert.equal(sent.outcome, 'submitted');
  const result = await waitFor(async () => {
    for (const entry of (await trace()).slice(offset)) {
      if (entry.pid !== controller.pid || entry.model !== 'controller') continue;
      const last = entry.context.messages.at(-1);
      if (last?.role === 'toolResult' && last.toolName === name) return last;
    }
  });
  assert.equal(result.isError === true, expectError, JSON.stringify(result));
  const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  try { return JSON.parse(text); } catch { return { error: text }; }
}
async function step(name, action) {
  const result = await action();
  reports.push({ name, result });
  await writeFile(config.results, JSON.stringify({ revision: config.revision, reports }, null, 2));
  console.log(`PASS ${name}: ${JSON.stringify(result)}`);
  return result;
}
function profile(model, fallbackModel) { return app('workflow.set', { profile: 'feature', model: `herdr-fixture/${model}`, fallbackModel: fallbackModel ? `herdr-fixture/${fallbackModel}` : null, thinking: 'off' }); }
function input(key, extra = {}) { return { requestId: `LPT1478-live-${stamp}-${key}`, name: `Fixture ${key} ${stamp}`, message: 'Verify LPT-1478: "quoted task"\nsecond line', folder: config.folder, profile: 'feature', ...extra }; }
const inspect = terminal => app('agent.inspect', { terminal, lines: 0, screen: false });
const target = ({ terminal, pid, session }) => ({ terminal, pid, session });

profile('success');
const successInput = input('success');
const success = await step('profile launch preserves the task and real identity', async () => {
  const created = await invoke('herdr_agent_create', successInput);
  assert.equal(created.outcome, 'started'); assert.equal(created.attempts.length, 1);
  assert.equal(created.model, 'herdr-fixture/success');
  const agent = inspect(created.terminal); assert.equal(agent.identityCurrent, true);
  const request = (await trace()).find(entry => entry.pid === agent.pid && entry.model === 'success');
  const first = request.context.messages.find(message => message.role === 'user');
  const message = typeof first.content === 'string' ? first.content : first.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.equal(message, successInput.message);
  return { terminal: agent.terminal, pid: agent.pid, session: agent.session, model: created.model };
});
await step('repeated creation reuses its receipt', async () => {
  const before = app('agent.list').agents.length;
  const repeated = await invoke('herdr_agent_create', successInput);
  assert.equal(repeated.reused, true); assert.equal(repeated.terminal, success.terminal);
  assert.equal(app('agent.list').agents.length, before);
  return { reused: repeated.reused, terminal: repeated.terminal };
});
await step('native follow-up reaches the selected Pi', async () => {
  const sent = await invoke('herdr_agent_send', { ...target(success), message: 'Follow-up with "quotes"\nand a newline' });
  assert.equal(sent.outcome, 'submitted');
  await waitFor(async () => (await trace()).some(entry => entry.pid === success.pid && JSON.stringify(entry.context.messages).includes('Follow-up with')));
  await waitFor(() => inspect(success.terminal).status === 'done');
  return { terminal: sent.terminal, outcome: sent.outcome };
});
await step('stale PID and self-removal are refused', async () => {
  assert.match((await invoke('herdr_agent_stop', { ...target(success), pid: success.pid + 1 }, true)).error, /identity|changed/i);
  assert.match((await invoke('herdr_agent_remove', { terminal: controller.terminal, pid: controller.pid, session: controller.session }, true)).error, /own/i);
  assert.equal(inspect(success.terminal).pid, success.pid); assert.equal(inspect(controller.terminal).pid, controller.pid);
  return { targetsPreserved: true };
});
profile('primary-error', 'success');
const fallback = await step('first-response failure permits exactly one fallback', async () => {
  const created = await invoke('herdr_agent_create', input('fallback'));
  assert.equal(created.outcome, 'started'); assert.equal(created.fallbackUsed, true); assert.equal(created.attempts.length, 2);
  assert.deepEqual(created.attempts.map(attempt => attempt.model), ['herdr-fixture/primary-error', 'herdr-fixture/success']);
  const primary = inspect(created.retainedPrimary.terminal);
  assert.equal(primary.startup, 'failed'); assert.ok(primary.startupError); assert.equal(primary.state, 'live');
  return { terminal: created.terminal, attempts: created.attempts.length, primaryRetained: primary.terminal };
});
profile('primary-error', 'fallback-error');
await step('failed fallback stops after its second attempt', async () => {
  const created = await invoke('herdr_agent_create', input('failed-fallback'), true);
  assert.equal(created.outcome, 'model-failed'); assert.equal(created.fallbackUsed, true); assert.equal(created.attempts.length, 2);
  return { outcome: created.outcome, attempts: created.attempts.length };
});
profile('late-error', 'success');
await step('later model error never reopens startup fallback', async () => {
  const created = await invoke('herdr_agent_create', input('late-error'));
  assert.equal(created.outcome, 'started'); assert.equal(created.attempts.length, 1);
  const agent = inspect(created.terminal);
  assert.equal((await invoke('herdr_agent_send', { terminal: agent.terminal, pid: agent.pid, session: agent.session, message: 'Trigger the later fixture error' })).outcome, 'submitted');
  await waitFor(() => inspect(agent.terminal).status === 'error');
  assert.equal(inspect(agent.terminal).startup, 'started');
  assert.equal(app('agent.list').agents.filter(row => row.name === agent.name).length, 1);
  return { terminal: agent.terminal, startup: inspect(agent.terminal).startup };
});
profile('slow');
await step('stop interrupts Pi without closing its tab', async () => {
  const created = await invoke('herdr_agent_create', input('stop'));
  const agent = inspect(created.terminal);
  await invoke('herdr_agent_send', { terminal: agent.terminal, pid: agent.pid, session: agent.session, message: 'Wait for the stop check' });
  await waitFor(() => inspect(agent.terminal).status === 'working');
  const stopped = await invoke('herdr_agent_stop', { terminal: agent.terminal, pid: agent.pid, session: agent.session });
  assert.equal(stopped.outcome, 'stopped');
  assert.equal(inspect(agent.terminal).pid, agent.pid); assert.equal(inspect(agent.terminal).state, 'live');
  return { terminal: agent.terminal, outcome: stopped.outcome };
});
await step('remove ends only the selected dedicated agent', async () => {
  const removed = await invoke('herdr_agent_remove', { terminal: success.terminal, pid: success.pid, session: success.session });
  assert.equal(removed.outcome, 'removed');
  await waitFor(() => !app('agent.list').agents.some(agent => agent.terminal === success.terminal));
  assert.equal(inspect(controller.terminal).pid, controller.pid);
  assert.equal(inspect(fallback.terminal).startup, 'started');
  return { removed: success.terminal, otherAgentsPreserved: true };
});
console.log(`Native App verification passed: ${reports.length} scenarios`);
