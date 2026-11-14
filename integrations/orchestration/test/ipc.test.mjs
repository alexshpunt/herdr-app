import assert from 'node:assert/strict';
import test from 'node:test';
import { startAgentIpc, requestAgentMessage } from '../ipc.mjs';

test('native Pi IPC refuses stale identity and submits one exact followup', async () => {
  const submitted = [];
  const ipc = await startAgentIpc({ pid: 7, session: 'session', validate: async () => {}, submit: message => submitted.push(message) });
  const request = { id: 'one', pid: 7, session: 'session', message: 'A follow-up, not shell input' };
  try {
    assert.match((await requestAgentMessage({ ...ipc, token: 'wrong' }, request)).error, /identity/i);
    assert.match((await requestAgentMessage(ipc, { ...request, pid: 8 })).error, /identity/i);
    assert.match((await requestAgentMessage(ipc, { ...request, session: 'stale' })).error, /identity/i);
    assert.equal(submitted.length, 0);
    const results = await Promise.all([requestAgentMessage(ipc, request), requestAgentMessage(ipc, request)]);
    assert.ok(results.every(result => result.outcome === 'submitted'));
    assert.deepEqual(submitted, [request.message]);
    assert.match((await requestAgentMessage(ipc, { ...request, message: 'different' })).error, /different/i);
    assert.equal(submitted.length, 1);
  } finally { await ipc.stop(); }
});

test('native Pi IPC refuses an exited foreground or blocked question without typing', async () => {
  let state = 'blocked', submitted = 0;
  const ipc = await startAgentIpc({ pid: 7, session: 'session', validate: async () => { throw new Error(state); }, submit: () => { submitted += 1; } });
  try {
    const request = { id: 'blocked', pid: 7, session: 'session', message: 'Do not type this' };
    assert.match((await requestAgentMessage(ipc, request)).error, /blocked/);
    state = 'foreground exited';
    assert.match((await requestAgentMessage(ipc, { ...request, id: 'exited' })).error, /exited/);
    assert.equal(submitted, 0);
  } finally { await ipc.stop(); }
});

test('reload closes an old IPC route before an in-flight message can submit', async () => {
  let release, entered, submitted = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const ipc = await startAgentIpc({ pid: 7, session: 'session', validate: async () => { entered(); await gate; }, submit: () => { submitted += 1; } });
  const pending = requestAgentMessage(ipc, { id: 'in-flight', pid: 7, session: 'session', message: 'old session message' }).catch(error => error);
  await started;
  await ipc.stop();
  release();
  assert.ok(await pending instanceof Error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(submitted, 0);
});