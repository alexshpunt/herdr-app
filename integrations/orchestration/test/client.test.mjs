import assert from 'node:assert/strict';
import test from 'node:test';
import { requestViaMailbox, resolveHc } from '../client.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const route = { version: 1, app: 'app-a', epoch: 'epoch-a', mailbox: 'herdr.orchestration.t1' };
const identity = { pid: 12, session: 'session-a', terminal: 't1' };
function fixture({ restart = false, accepted = false, conflicts = 0, unknown = false } = {}) {
  let version = 0, value = null, writes = 0;
  const calls = [];
  return { calls, get writes() { return writes; }, async call(method, args) {
    calls.push([method, structuredClone(args)]);
    if (method === 'doc.get') {
      if (value && restart) return { version, value: { version: 1, epoch: 'new-epoch', requests: {} } };
      return { version, value: structuredClone(value) };
    }
    if (method === 'doc.set') {
      if (unknown) throw Object.assign(new Error('Connection lost; effect unknown'), { code: 'disconnected' });
      if (conflicts-- > 0 || args.version !== version) throw Object.assign(new Error('Concurrent edit'), { code: 'conflict' });
      writes++;
      value = structuredClone(args.value); version++;
      for (const request of Object.values(value.requests)) if (request.state === 'ready') {
        request.state = accepted ? 'accepted' : 'done';
        request.result = { agents: [], marker: 'origin-app' };
      }
      return { version };
    }
    if (method === 'terminal.label') return {};
    throw new Error(`Unexpected ${method}`);
  } };
}
test('mailbox routes through the terminal core, not an arbitrary local App', async () => {
  const core = fixture();
  const result = await requestViaMailbox(core, route, identity, { do: 'agent.list', args: {} }, { timeout: 50, pollMs: 0 });
  assert.equal(result.marker, 'origin-app');
  const submitted = core.calls.find(([method, args]) => method === 'doc.set' && Object.keys(args.value.requests).length);
  const request = Object.values(submitted[1].value.requests)[0];
  assert.equal(request.pid, 12); assert.equal(request.session, 'session-a');
  assert.deepEqual(request.wire, { do: 'agent.list', args: {} });
  const trigger = core.calls.find(([method]) => method === 'terminal.label')[1];
  assert.equal(typeof trigger.labels['herdr.app.request'], 'string');
  assert.equal(Array.isArray(trigger.labels), false, 'core JSON labels use an object, not CLI key=value arguments');
});
test('mailbox retries explicit CAS conflicts but not unknown effects', async () => {
  const conflict = fixture({ conflicts: 1 });
  assert.equal((await requestViaMailbox(conflict, route, identity, { ls: true }, { timeout: 50, pollMs: 0 })).marker, 'origin-app');
  const unknown = fixture({ unknown: true });
  await assert.rejects(requestViaMailbox(unknown, route, identity, { do: 'tab.new', args: {} }, { timeout: 50, pollMs: 0 }), /unknown/);
  assert.equal(unknown.calls.filter(([method]) => method === 'doc.set').length, 1);
});
test('accepted requests time out without replay and an App restart is unknown', async () => {
  const core = fixture({ accepted: true });
  await assert.rejects(requestViaMailbox(core, route, identity, { do: 'tab.new', args: {} }, { timeout: 8, pollMs: 1 }), /unknown|not confirmed/i);
  assert.equal(core.writes, 1);
  await assert.rejects(requestViaMailbox(fixture({ restart: true }), route, identity, { ls: true }, { timeout: 50, pollMs: 0 }), /restart|epoch|unknown/i);
});
test('a missing route refuses instead of contacting an unrelated App', async () => {
  await assert.rejects(requestViaMailbox(fixture(), undefined, identity, { ls: true }), /reload|route/i);
});
test('direct launches find hc without a login-shell PATH', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'herdr-hc-path-'));
  try {
    const directory = process.platform === 'win32' ? path.join(home, 'AppData', 'Local', 'Programs', 'herdr-core') : path.join(home, '.local', 'bin');
    await mkdir(directory, { recursive: true });
    const command = path.join(directory, process.platform === 'win32' ? 'hc.exe' : 'hc');
    await writeFile(command, 'fixture');
    assert.equal(resolveHc({ home, env: { PATH: '' } }), command);
    assert.equal(resolveHc({ home, env: { PATH: '', HC_BIN: 'explicit-hc' } }), 'explicit-hc');
  } finally { await rm(home, { recursive: true, force: true }); }
});