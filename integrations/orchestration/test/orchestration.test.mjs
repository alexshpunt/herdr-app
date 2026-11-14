import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Orchestrator, startupOutcome, bindOrigin } from '../orchestration.mjs';

const origin = { pid: 12, session: 'caller', terminal: 'm/t1', machine: 'm', space: 'm/sp1' };
const config = { version: 1, profiles: [{ id: 'feature', name: 'Features', model: 'p/main', fallbackModel: 'p/backup', thinking: 'high' }] };
const record = startup => ({ terminal: 'm/t2', tab: 'm/tb2', space: 'm/sp1', state: 'live', pid: 22, session: 'child', startup });
function client(states = [record('started')]) {
  const calls = [];
  return { calls, context: async () => origin, workflow: async () => config,
    launch: async args => { calls.push(['launch', args]); return { terminal: 'm/t2', tab: 'm/tb2', space: 'm/sp1' }; },
    inspect: async () => states.length > 1 ? states.shift() : states[0],
    remove: async args => { calls.push(['remove', args]); },
    send: async args => { calls.push(['send', args]); }, stop: async args => { calls.push(['stop', args]); },
  };
}
const input = { requestId: 'LPT-1', name: 'LPT-1 task', folder: '/repo', profile: 'feature', message: 'Implement task LPT-1' };
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-orchestration-unit-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('origin requires this foreground PID and an unambiguous stable placement', () => {
  const terminal = { address: 't1', foreground: { pid: 12 }, labels: { 'herdr.space': 'sp1' } };
  const snapshot = { spaces: [{ id: 'm/sp1', machine: 'm', tabs: [{ id: 'm/tb1', terminals: [{ terminal: 'm/t1', pane: 'm/p1' }] }] }] };
  assert.equal(bindOrigin(snapshot, terminal, 12, 's').terminal, 'm/t1');
  assert.equal(bindOrigin(snapshot, { ...terminal, pid: 12, foreground: undefined }, 12, 's').terminal, 'm/t1');
  assert.throws(() => bindOrigin(snapshot, terminal, 13, 's'), /foreground/);
  assert.throws(() => bindOrigin({ spaces: [...snapshot.spaces, ...snapshot.spaces] }, terminal, 12, 's'), /unambiguous/);
});
test('first successful response is a permanent startup boundary', () => {
  assert.equal(startupOutcome({ state: 'live', startup: 'started', status: 'error' }), 'started');
  assert.equal(startupOutcome({ state: 'live', startup: 'failed' }), 'model-failed');
  assert.equal(startupOutcome({ state: 'live', status: 'blocked' }), 'blocked');
  assert.equal(startupOutcome({ state: 'live', status: 'error' }), 'pending');
  assert.equal(startupOutcome({ state: 'finished', startup: 'started' }), 'started');
});
test('request receipts survive reload and prevent duplicate launches', () => fixture(async root => {
  const api = client();
  const first = await new Orchestrator(api, root, { pollMs: 0 }).create(input);
  const second = await new Orchestrator(api, root).create(input);
  assert.equal(first.outcome, 'started');
  assert.equal(second.reused, true);
  assert.equal(api.calls.filter(c => c[0] === 'launch').length, 1);
  await assert.rejects(new Orchestrator(api, root).create({ ...input, message: 'different task' }), /different/);
}));
test('concurrent same-key calls do not duplicate a task', () => fixture(async root => {
  const api = client();
  const results = await Promise.allSettled([new Orchestrator(api, root).create(input), new Orchestrator(api, root).create(input)]);
  assert.equal(api.calls.filter(c => c[0] === 'launch').length, 1);
  assert.ok(results.some(r => r.status === 'fulfilled'));
}));
test('only explicit first-response failure starts fallback, exactly once', () => fixture(async root => {
  const api = client([record('failed'), record('failed'), record('started')]);
  let next = 1;
  api.launch = async args => { api.calls.push(['launch', args]); return { terminal: `m/t${++next}`, tab: `m/tb${next}`, space: 'm/sp1' }; };
  const result = await new Orchestrator(api, root, { pollMs: 0 }).create(input);
  assert.equal(result.outcome, 'started');
  assert.equal(result.model, 'p/backup');
  assert.deepEqual(api.calls.filter(c => c[0] === 'launch').map(c => c[1].model), ['p/main', 'p/backup']);
  assert.equal(api.calls.filter(c => c[0] === 'remove').length, 0);
  assert.equal(result.retainedPrimary.terminal, 'm/t2');
}));
test('unknown launch effect is never retried after reload', () => fixture(async root => {
  const api = client();
  api.launch = async () => { api.calls.push(['launch']); throw new Error('connection lost'); };
  const first = await new Orchestrator(api, root).create(input);
  assert.equal(first.outcome, 'unknown');
  const again = await new Orchestrator(api, root).create(input);
  assert.equal(again.outcome, 'unknown');
  assert.equal(api.calls.length, 1);
}));
test('blocked startup and cancellation never trigger fallback', () => fixture(async root => {
  const api = client([{ ...record('pending'), status: 'blocked' }]);
  assert.equal((await new Orchestrator(api, root).create(input)).outcome, 'blocked');
  assert.equal(api.calls.length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new Orchestrator(api, root).create({ ...input, requestId: 'cancelled' }, controller.signal), /abort/i);
  assert.equal(api.calls.length, 1);
}));
test('send protects blocked agents, self and stale identities', () => fixture(async root => {
  const api = client([{ ...record('started'), status: 'blocked' }]);
  const service = new Orchestrator(api, root);
  await assert.rejects(service.act('send', { terminal: 'm/t2', pid: 22, session: 'child', message: 'hello' }), /blocked/);
  await assert.rejects(service.act('stop', { terminal: 'm/t1', pid: 12, session: 'caller' }), /own/);
  await assert.rejects(service.act('remove', { terminal: 'm/t2', pid: 99, session: 'child' }), /changed/);
  assert.equal(api.calls.length, 0);
}));
test('stop preserves the core observation instead of claiming success', () => fixture(async root => {
  const api = client();
  api.stop = async () => ({ outcome: 'still_working', key: 'escape' });
  const result = await new Orchestrator(api, root).act('stop', { terminal: 'm/t2', pid: 22, session: 'child' });
  assert.equal(result.outcome, 'still_working');
  assert.equal(result.key, 'escape');
}));
test('a recovered primary is rechecked before starting fallback', () => fixture(async root => {
  const api = client([record('failed'), record('started')]);
  const result = await new Orchestrator(api, root, { pollMs: 0 }).create(input);
  assert.equal(result.outcome, 'started');
  assert.equal(result.model, 'p/main');
  assert.equal(api.calls.filter(c => c[0] === 'launch').length, 1);
  assert.equal(api.calls.filter(c => c[0] === 'remove').length, 0);
}));
test('pending fallback never inherits the primary PID or session', () => fixture(async root => {
  const api = client([record('failed'), record('failed'), { ...record('pending'), pid: 33, session: 'fallback' }]);
  let next = 1;
  api.launch = async args => { api.calls.push(['launch', args]); return { terminal: `m/t${++next}`, tab: `m/tb${next}`, space: 'm/sp1' }; };
  const result = await new Orchestrator(api, root, { pollMs: 0, startupMs: 0 }).create(input);
  assert.equal(result.outcome, 'pending');
  assert.equal(result.terminal, 'm/t3');
  assert.equal(result.pid, undefined);
  assert.equal(result.session, undefined);
  assert.equal(result.attempts.length, 2);
  assert.equal(api.calls.filter(c => c[0] === 'remove').length, 0);
}));
test('fallback does not remove a primary which the user may resume', () => fixture(async root => {
  const api = client([record('failed'), record('failed'), record('started')]);
  const result = await new Orchestrator(api, root, { pollMs: 0 }).create(input);
  assert.equal(result.outcome, 'started');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.retainedPrimary.terminal, 'm/t2');
  assert.equal(api.calls.filter(c => c[0] === 'remove').length, 0);
}));
test('startup and mutation guards read metadata without capturing a starting terminal', () => fixture(async root => {
  const api = client();
  const inspections = [];
  api.inspect = async (...args) => { inspections.push(args); return record('started'); };
  await new Orchestrator(api, root).create(input);
  await new Orchestrator(api, root).act('send', { terminal: 'm/t2', pid: 22, session: 'child', message: 'Follow up' });
  assert.deepEqual(inspections, [['m/t2', 0, false], ['m/t2', 0, false]]);
}));