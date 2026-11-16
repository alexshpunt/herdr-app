// Opt-in installed Windows App check. Use an isolated controller and core only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.match(config.coreSession, /^test-/);
assert.ok(config.exe && config.appHome && config.trace && config.controller);
const env = { ...process.env, HC_SESSION: config.coreSession, HERDR_APP_HOME: config.appHome };
function app(command, args = {}) {
  const result = spawnSync(config.exe, ['do', command, JSON.stringify(args)], { env, encoding: 'utf8', timeout: 105000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = JSON.parse(result.stdout);
  assert.ok(!value.error, JSON.stringify(value));
  return value;
}
async function trace() { return (await readFile(config.trace, 'utf8')).split('\n').slice(0, -1).filter(Boolean).map(JSON.parse); }
async function waitFor(probe) {
  const until = Date.now() + 45000;
  do { const value = await probe(); if (value) return value; await delay(300); } while (Date.now() < until);
  throw new Error('Inspection fixture deadline exceeded');
}
const controller = app('agent.inspect', { terminal: config.controller, screen: false });
const target = ({ terminal, pid, session }) => ({ terminal, pid, session });
async function invoke(name, args) {
  const offset = (await trace()).length;
  assert.equal(app('agent.send', { ...target(controller), message: JSON.stringify({ name, arguments: args }) }).outcome, 'submitted');
  return waitFor(async () => {
    for (const entry of (await trace()).slice(offset)) {
      if (entry.pid !== controller.pid) continue;
      const last = entry.context.messages.at(-1);
      if (last?.role === 'toolResult' && last.toolName === name) {
        assert.ok(!last.isError, JSON.stringify(last));
        const text = last.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        return { data: name === 'herdr_agent_create' ? JSON.parse(text) : text, chars: text.length };
      }
    }
  });
}
const reports = [];
async function record(name, run) {
  const result = await run(); reports.push({ name, result });
  await writeFile(config.results, JSON.stringify({ revision: config.revision, reports }, null, 2));
  console.log(`PASS ${name}: ${JSON.stringify(result)}`);
  return result;
}
async function create(model, message = 'Fixture decision: PR #42 merged') {
  const result = await invoke('herdr_agent_create', { requestId: `inspect-${Date.now()}-${model}`, name: `Inspect ${model}`, message, folder: config.folder, profile: 'feature', model: `herdr-fixture/${model}`, fallbackModel: null });
  assert.equal(result.data.outcome, 'started'); return result.data;
}
const done = await create('success');
await record('resource read contains the fixture decision', async () => {
  const { data, chars } = await invoke('read', { path: `herdr:${done.terminal}` });
  assert.ok(data.includes('PR #42 merged'));
  assert.ok(chars <= 3500);
  const repeat = await invoke('read', { path: `herdr:${done.terminal}` });
  assert.ok(!repeat.data.includes('PR #42 merged'));
  return { terminal: done.terminal, chars, data };
});
await record('metadata and full-screen modes remain explicit', async () => {
  const metadata = app('agent.inspect', { terminal: done.terminal, screen: false });
  assert.ok(!('inspection' in metadata)); assert.ok(!('screen' in metadata));
  const full = app('agent.inspect', { terminal: done.terminal, screen: true, lines: 0 });
  assert.equal(full.source, 'screen'); assert.ok(full.screen.includes('PR #42 merged'));
  const fullChars = JSON.stringify(full).length;
  return { compactChars: reports[0].result.chars, fullChars, reduction: 1 - reports[0].result.chars / fullChars };
});
await record('old integration fails without reading a terminal screen', async () => {
  const runHc = args => { const result = spawnSync(config.hc, args, { env, encoding: 'utf8', timeout: 15000 }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  const id = done.terminal.split('/').at(-1);
  const original = runHc(['get', id, '--json']).labels['herdr.pi'];
  try {
    runHc(['label', id, `herdr.pi=${JSON.stringify({ ...JSON.parse(original), inspect: 0 })}`, '--json']);
    const refused = spawnSync(config.exe, ['do', 'agent.inspect', JSON.stringify({ terminal: done.terminal })], { env, encoding: 'utf8', timeout: 20000 });
    assert.notEqual(refused.status, 0);
    const data = JSON.parse(refused.stdout);
    assert.ok(data.error); assert.ok(!('screen' in data));
    return data;
  } finally { runHc(['label', id, `herdr.pi=${original}`, '--json']); }
});
const long = await create('success', 'Fixture context '.repeat(1000) + 'Final decision: PR #43 merged');
await record('long reply is bounded and truncation is explicit', async () => {
  const { data, chars } = await invoke('read', { path: `herdr:${long.terminal}`, views: ['budget:500'] });
  assert.ok(data.includes('Fixture context')); assert.ok(data.includes('PR #43 merged'));
  assert.ok(chars <= 1000);
  return { chars, data };
});
const work = await create('inspect-work');
await record('current tool is visible during real execution', async () => {
  await waitFor(() => app('agent.inspect', { terminal: work.terminal }).inspection?.events.some(event => event.kind === 'call' && event.tool === 'fixture_wait' && event.state === 'running'));
  const { data, chars } = await invoke('read', { path: `herdr:${work.terminal}` });
  assert.ok(data.includes('fixture_wait'));
  app('agent.stop', target(work));
  return { chars, data };
});
const failed = await create('late-error');
app('agent.send', { ...target(failed), message: 'Trigger fixture failure' });
await record('model error is distinct from no response', async () => {
  await waitFor(() => app('agent.inspect', { terminal: failed.terminal }).inspection?.failed);
  const { data, chars } = await invoke('read', { path: `herdr:${failed.terminal}` });
  const snapshot = app('agent.inspect', { terminal: failed.terminal }).inspection;
  assert.ok(data.includes(snapshot.lastError)); assert.ok(chars <= 3500);
  return { chars, data };
});
const question = await create('inspect-question');
await record('pending question is readable but cannot be answered through send', async () => {
  await waitFor(() => app('agent.inspect', { terminal: question.terminal }).inspection?.pendingQuestion);
  const { data, chars } = await invoke('read', { path: `herdr:${question.terminal}` });
  assert.ok(data.includes('Which release should ship?')); assert.ok(data.includes('Stable')); assert.ok(chars <= 3500);
  const refused = spawnSync(config.exe, ['do', 'agent.send', JSON.stringify({ ...target(question), message: 'Do not bypass' })], { env, encoding: 'utf8', timeout: 20000 });
  assert.notEqual(refused.status, 0); assert.ok(JSON.parse(refused.stdout).error);
  return { chars, data };
});
console.log('Inspection checks passed. Keep the question open for visual verification, then clean up this test instance.');
