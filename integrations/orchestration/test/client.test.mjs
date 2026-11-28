import assert from 'node:assert/strict';
import test from 'node:test';
import { AppClient, ownsTerminal, requestViaMailbox, resolveHc, workflowSelectionError } from '../client.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
test('workflow startup refuses a silently substituted model or thinking level', () => {
  const selected = { provider: 'p', id: 'model' };
  assert.equal(workflowSelectionError('p/model', 'high', selected, 'high'), undefined);
  for (const [model, level] of [[selected, 'off'], [{ provider: 'p', id: 'different' }, 'high'], [undefined, 'high']]) {
    const error = workflowSelectionError('p/model', 'high', model, level);
    assert.equal(typeof error, 'string');
    assert.ok(error.includes('p/model'));
  }
  assert.equal(workflowSelectionError(undefined, undefined, selected, 'off'), undefined);
});
const route = { version: 1, app: 'app-a', epoch: 'epoch-a', mailbox: 'herdr.orchestration.t1' };
const identity = { pid: 12, session: 'session-a', terminal: 't1' };
function fixture({ restart = false, accepted = false, conflicts = 0, unknown = false, acknowledgementConflicts = 0, concurrentEntry, initialValue = null, refusal } = {}) {
  let version = 0, value = structuredClone(initialValue), writes = 0;
  const calls = [];
  return { calls, get writes() { return writes; }, get value() { return structuredClone(value); }, remove(id) { delete value.requests[id]; version++; }, async call(method, args) {
    calls.push([method, structuredClone(args)]);
    if (method === 'doc.get') {
      if (value && restart) return { version, value: { version: 1, epoch: 'new-epoch', requests: {} } };
      return { version, value: structuredClone(value) };
    }
    if (method === 'doc.set') {
      if (unknown) throw Object.assign(new Error('Connection lost; effect unknown'), { code: 'disconnected' });
      const acknowledging = value && Object.keys(value.requests).some(id => value.requests[id].state === 'done' && !(id in args.value.requests));
      if (acknowledging && acknowledgementConflicts > 0) {
        if (concurrentEntry) value.requests['concurrent'] = structuredClone(concurrentEntry);
        acknowledgementConflicts--; version++;
        throw Object.assign(new Error('Concurrent edit'), { code: 'conflict' });
      }
      if (conflicts-- > 0 || args.version !== version) throw Object.assign(new Error('Concurrent edit'), { code: 'conflict' });
      writes++;
      value = structuredClone(args.value); version++;
      for (const request of Object.values(value.requests)) if (request.state === 'ready') {
        request.state = accepted ? 'accepted' : 'done';
        request.result = refusal ?? { agents: [], marker: 'origin-app' };
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
test('a completed request is acknowledged after a concurrent mailbox update', async () => {
  const core = fixture({ acknowledgementConflicts: 2 });
  const result = await requestViaMailbox(core, route, identity, { do: 'agent.list', args: {} }, { timeout: 200, pollMs: 1 });
  assert.equal(result.marker, 'origin-app');
  assert.deepEqual(core.value.requests, {});
  assert.equal(core.calls.filter(([method, args]) => method === 'doc.set' && Object.keys(args.value.requests).length > 0).length, 1);
});
test('acknowledgement after a conflict preserves a concurrent request', async () => {
  const concurrentEntry = { state: 'accepted', expires: Date.now() + 5000, wire: { do: 'tab.new', args: {} } };
  const core = fixture({ acknowledgementConflicts: 1, concurrentEntry });
  const result = await requestViaMailbox(core, route, identity, { do: 'agent.list', args: {} }, { timeout: 200, pollMs: 1 });
  assert.equal(result.marker, 'origin-app');
  assert.deepEqual(core.value.requests, { concurrent: concurrentEntry });
});
test('an unconfirmed acknowledgement does not replay a completed mutation', async () => {
  const base = fixture();
  const core = { calls: base.calls, async call(method, args) {
    if (method === 'doc.set' && base.value && Object.keys(args.value.requests).length === 0) {
      base.calls.push([method, structuredClone(args)]);
      throw Object.assign(new Error('Connection lost'), { code: 'disconnected' });
    }
    return base.call(method, args);
  } };
  const result = await requestViaMailbox(core, route, identity, { do: 'tab.new', args: {} }, { timeout: 200, pollMs: 1 });
  assert.equal(result.marker, 'origin-app');
  assert.equal(Object.keys(base.value.requests).length, 1);
  assert.equal(core.calls.filter(([method, args]) => method === 'doc.set' && Object.keys(args.value.requests).length === 0).length, 1);
  assert.equal(core.calls.filter(([method]) => method === 'terminal.label').length, 1);
});
test('a full mailbox waits for expired entries instead of rejecting a new request', async () => {
  const expires = Date.now() + 30;
  const entries = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`old-${i}`, { state: 'done', expires }]));
  const core = fixture({ initialValue: { version: 1, epoch: route.epoch, requests: entries } });
  const result = await requestViaMailbox(core, route, identity, { do: 'agent.list', args: {} }, { timeout: 200, pollMs: 5 });
  assert.equal(result.marker, 'origin-app');
  assert.deepEqual(core.value.requests, {});
});
test('a full mailbox admits a new request after another caller acknowledges its result', async () => {
  const entries = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`old-${i}`, { state: 'done', expires: Date.now() + 5000 }]));
  const core = fixture({ initialValue: { version: 1, epoch: route.epoch, requests: entries } });
  const request = requestViaMailbox(core, route, identity, { do: 'agent.list', args: {} }, { timeout: 200, pollMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(core.writes, 0);
  core.remove('old-0');
  assert.equal((await request).marker, 'origin-app');
  delete entries['old-0'];
  assert.deepEqual(core.value.requests, entries);
});
test('a mailbox full past the deadline does not submit a new mutation', async () => {
  const entries = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`old-${i}`, { state: 'accepted', expires: Date.now() + 5000 }]));
  const core = fixture({ initialValue: { version: 1, epoch: route.epoch, requests: entries } });
  await assert.rejects(requestViaMailbox(core, route, identity, { do: 'tab.new', args: {} }, { timeout: 30, pollMs: 5 }), error => error.code === 'HERDR_NOT_SUBMITTED' && error.effect === 'not-applied');
  assert.equal(core.calls.filter(([method]) => method === 'doc.set' || method === 'terminal.label').length, 0);
  assert.deepEqual(core.value.requests, entries);
});
test('a mutation is not dispatched later after it encountered a full mailbox', async () => {
  const entries = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`old-${i}`, { state: 'done', expires: Date.now() + 5000 }]));
  const core = fixture({ initialValue: { version: 1, epoch: route.epoch, requests: entries } });
  const request = requestViaMailbox(core, route, identity, { do: 'tab.new', args: {} }, { timeout: 100, pollMs: 5 });
  const result = request.then(() => 'submitted', () => 'refused');
  await new Promise(resolve => setTimeout(resolve, 20));
  core.remove('old-0');
  assert.equal(await result, 'refused');
  assert.equal(core.calls.filter(([method]) => method === 'doc.set' || method === 'terminal.label').length, 0);
});
test('concurrent calls above the mailbox bound complete without losing or leaving results', async () => {
  const core = fixture();
  const calls = Array.from({ length: 12 }, (_, i) => requestViaMailbox(core, route, identity, { do: 'agent.inspect', args: { terminal: `t${i}` } }, { timeout: 2000, pollMs: 1 }));
  const results = await Promise.all(calls);
  assert.equal(results.length, 12);
  assert.ok(results.every(result => result.marker === 'origin-app'));
  assert.deepEqual(core.value.requests, {});
});
test('a delayed mailbox read cannot submit a mutation after the admission deadline', async () => {
  const base = fixture();
  const core = { calls: base.calls, async call(method, args) {
    if (method === 'doc.get') await new Promise(resolve => setTimeout(resolve, 30));
    return base.call(method, args);
  } };
  await assert.rejects(requestViaMailbox(core, route, identity, { do: 'tab.new', args: {} }, { timeout: 10, pollMs: 1 }));
  assert.equal(core.calls.filter(([method]) => method === 'doc.set' || method === 'terminal.label').length, 0);
});
test('accepted requests time out without replay and an App restart is unknown', async () => {
  const core = fixture({ accepted: true });
  await assert.rejects(requestViaMailbox(core, route, identity, { do: 'tab.new', args: {} }, { timeout: 8, pollMs: 1 }), /unknown|not confirmed/i);
  assert.equal(core.writes, 1);
  await assert.rejects(requestViaMailbox(fixture({ restart: true }), route, identity, { ls: true }, { timeout: 50, pollMs: 0 }), /restart|epoch|unknown/i);
});
test('each agent opens in a new space named after it; a fallback joins its given space', async () => {
  const app = new AppClient(() => {}, 12, 'session-a');
  const calls = [];
  app.context = async () => ({ machine: 'laptop', space: 'laptop/sp1' });
  app.command = async (name, args) => { calls.push([name, args]); return name === 'tab.new' ? { terminal: 'laptop/t3', tab: 'laptop/tb3' } : { space: 'laptop/sp2', tab: 'laptop/tb2', terminal: 'laptop/t2' }; };
  const input = { name: 'LPT-1 task', folder: '/repo', model: 'p/main', thinking: 'high', message: 'Implement LPT-1' };
  assert.equal((await app.launch(input)).space, 'laptop/sp2');
  assert.deepEqual(calls[0], ['space.new', { folder: '/repo', argv: ['pi', '--model', 'p/main', '--thinking', 'high', '--herdr-workflow-model', 'p/main', '--herdr-workflow-thinking', 'high'], task: 'Implement LPT-1', focus: false, name: 'LPT-1 task', tab: 'LPT-1 task', machine: 'laptop' }]);
  await app.launch({ ...input, machine: '' });
  assert.equal(calls[1][1].machine, '', 'an explicit empty machine selects the App\u2019s own computer');
  assert.equal((await app.launch({ ...input, space: 'laptop/sp2' })).space, 'laptop/sp2');
  assert.deepEqual([calls[2][0], calls[2][1].space, calls[2][1].focus], ['tab.new', 'laptop/sp2', false]);
  // A sub-agent's launch tells its Pi how deeply it is nested.
  await app.launch({ ...input, space: 'laptop/sp1', depth: 1 });
  assert.deepEqual(calls[3][1].argv.slice(-2), ['--herdr-depth', '1']);
});
test('a replica opens its session copy with Pi in a new tab of the caller\u2019s space', async () => {
  const app = new AppClient(() => {}, 12, 'session-a');
  const calls = [];
  app.context = async () => ({ machine: 'laptop', space: 'laptop/sp1' });
  app.command = async (name, args) => { calls.push([name, args]); return { terminal: 'laptop/t4', tab: 'laptop/tb4' }; };
  const input = { name: 'check-auth', session: '/home/u/.pi/agent/sessions/x/replica.jsonl', folder: '/repo', model: 'p/main', thinking: 'high', task: 'Check auth\n"quoted"' };
  assert.deepEqual(await app.replicate(input), { terminal: 'laptop/t4', tab: 'laptop/tb4', space: 'laptop/sp1' });
  assert.deepEqual(calls[0], ['tab.new', { space: 'laptop/sp1', name: 'check-auth', folder: '/repo',
    argv: ['pi', '--session', input.session, '--model', 'p/main', '--thinking', 'high'], task: input.task, focus: false }]);
  await app.replicate({ ...input, session: 'C:\\Users\\u\\s.jsonl', folder: 'C:\\repo', thinking: undefined });
  assert.deepEqual(calls[1][1].argv, ['pi', '--session', 'C:\\Users\\u\\s.jsonl', '--model', 'p/main']);
  await app.replicate({ ...input, depth: 2 });
  assert.deepEqual(calls[2][1].argv.slice(-2), ['--herdr-depth', '2']);
  for (const bad of [{ task: ' ' }, { folder: 'repo' }, { session: '/tmp/s.txt' }, { session: 'relative.jsonl' }, { thinking: 'max' }, { model: undefined }, { depth: 0 }, { depth: '1' }])
    await assert.rejects(app.replicate({ ...input, ...bad }), /agent\.replicate/);
  assert.equal(calls.length, 3, 'invalid input launches nothing');
});
test('tracked calls preserve session, tool call, and result until the exact revision is acknowledged', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-tracked-'));
  try {
    const app = new AppClient(() => {}, 12, 'session-a', { recoveryRoot: root });
    app.owner = async () => ({});
    const call = await app.tracked('agent.inspect', 'call-1', async () => ({ terminal: 'workstation/t1' }));
    const entries = await app.recoveryList();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, call.id);
    assert.equal(entries[0].revision, call.revision);
    assert.equal(entries[0].toolCallId, 'call-1');
    assert.deepEqual(entries[0].result, call.result);
    await app.recoveryAck({ items: [{ id: call.id, revision: entries[0].revision }] });
    assert.deepEqual(await app.recoveryList(), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a tracked App result remains durable until acknowledgement and cleanup retries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-tracked-'));
  const previous = process.env.HC_TERMINAL_ID;
  const documents = new Map();
  let failCleanup = true;
  const read = name => documents.get(name) ?? { version: 0, value: null };
  const core = { close() {}, async call(method, args) {
    if (method === 'doc.get') return structuredClone(read(args.name));
    if (method === 'doc.set') {
      const current = read(args.name);
      if (args.version !== current.version) throw Object.assign(new Error('conflict'), { code: 'conflict' });
      if (args.value === null && failCleanup) { failCleanup = false; throw new Error('offline'); }
      documents.set(args.name, { version: current.version + 1, value: structuredClone(args.value) });
      return {};
    }
    if (method === 'terminal.label') {
      const mailbox = read('mailbox');
      for (const request of Object.values(mailbox.value.requests)) if (request.state === 'ready') {
        const receipt = read(request.receipt);
        const result = { sent: true };
        documents.set(request.receipt, { version: receipt.version + 1, value: { ...receipt.value, state: 'done', result } });
        request.state = 'done'; request.result = result;
      }
      documents.set('mailbox', { version: mailbox.version + 1, value: mailbox.value });
      return {};
    }
    throw new Error(`Unexpected ${method}`);
  } };
  try {
    process.env.HC_TERMINAL_ID = 't1';
    const app = new AppClient(() => {}, 12, 'session-a', { recoveryRoot: root, coreFactory: () => core });
    app.owner = async () => ({ labels: { 'herdr.app': JSON.stringify({ ...route, mailbox: 'mailbox', receipts: 1 }) } });
    const call = await app.tracked('agent.send', 'call-1', () => app.command('agent.send', { terminal: 'workstation/t2' }));
    assert.deepEqual(call.result, { sent: true });
    const receiptName = [...documents.keys()].find(name => name.startsWith('hr.'));
    assert.equal(read(receiptName).value.state, 'done');
    assert.equal((await app.recoveryAck({ items: [{ id: call.id, revision: call.revision }] })).cleanupPending.length, 1);
    assert.equal(read(receiptName).value.state, 'done');
    assert.deepEqual(await app.recoveryAck({ items: [] }), { cleanupPending: [] });
    assert.equal(read(receiptName).value, null);
  } finally {
    if (previous === undefined) delete process.env.HC_TERMINAL_ID; else process.env.HC_TERMINAL_ID = previous;
    await rm(root, { recursive: true, force: true });
  }
});
test('a definitely unsubmitted tracked request exposes its recorded revision', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-tracked-'));
  try {
    const app = new AppClient(() => {}, 12, 'session-a', { recoveryRoot: root });
    app.owner = async () => ({});
    let failure;
    try { await app.tracked('agent.send', null, async () => { throw Object.assign(new Error('busy'), { code: 'HERDR_NOT_SUBMITTED', effect: 'not-applied' }); }); }
    catch (error) { failure = error; }
    assert.equal(failure.code, 'HERDR_NOT_SUBMITTED');
    assert.equal(failure.effect, 'not-applied');
    const entry = (await app.recoveryList())[0];
    assert.equal(failure.requestId, entry.id);
    assert.equal(failure.revision, entry.revision);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('an App refusal before dispatch is recorded as not applied and can be acknowledged', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-refused-'));
  const previous = process.env.HC_TERMINAL_ID;
  const documents = new Map();
  const mailbox = fixture({ refusal: { error: 'fixture', code: 'HERDR_RECEIPT_REFUSED', effect: 'not-applied' } });
  const core = { close() {}, async call(method, args) {
    if (args.name?.startsWith('hr.')) {
      if (method === 'doc.set') { documents.set(args.name, { version: 1, value: args.value }); return {}; }
      if (method === 'doc.get') return documents.get(args.name) ?? { version: 0, value: null };
    }
    return mailbox.call(method, args);
  } };
  try {
    process.env.HC_TERMINAL_ID = 't1';
    const app = new AppClient(() => {}, 12, 'session-a', { recoveryRoot: root, coreFactory: () => core });
    app.owner = async () => ({ labels: { 'herdr.app': JSON.stringify({ ...route, receipts: 1 }) } });
    let failure;
    try { await app.tracked('agent.send', null, () => app.command('agent.send', { terminal: 'workstation/t2' })); }
    catch (error) { failure = error; }
    assert.equal(failure?.code, 'HERDR_NOT_SUBMITTED');
    assert.equal(failure.effect, 'not-applied');
    assert.equal(failure.reason, 'storage');
    const [entry] = await app.recoveryList();
    assert.equal(entry.state, 'error');
    assert.deepEqual(await app.recoveryAck({ items: [{ id: entry.id, revision: entry.revision }] }), { cleanupPending: [] });
    assert.deepEqual(await app.recoveryList(), []);
    assert.equal([...documents.values()][0].value.state, 'pending');
    let composite;
    try { await app.tracked('agent.subagent', null, () => {
      app.tracking.getStore().admittedMutation = 1;
      return app.command('agent.send', { terminal: 'workstation/t2' });
    }); } catch (error) { composite = error; }
    assert.equal(composite?.code, 'HERDR_OUTCOME_UNKNOWN');
    assert.equal(composite.effect, 'unknown');
    const [partial] = await app.recoveryList();
    assert.equal(partial.state, 'unknown');
    assert.equal(partial.evidence[0].state, 'done');
    await app.recoveryAck({ items: [{ id: partial.id, revision: partial.revision }] });
    assert.deepEqual(await app.recoveryList(), []);
  } finally {
    if (previous === undefined) delete process.env.HC_TERMINAL_ID; else process.env.HC_TERMINAL_ID = previous;
    await rm(root, { recursive: true, force: true });
  }
});
test('tracked refusals retain the reason for a safe recovery action', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-tracked-reasons-'));
  try {
    const core = { close() {}, async call() { throw new Error('storage fixture'); } };
    const app = new AppClient(() => {}, 12, 'session-a', { recoveryRoot: root, coreFactory: () => core });
    app.owner = async () => ({ labels: { 'herdr.app': JSON.stringify(route) } });
    await assert.rejects(app.tracked('agent.list', null, () => app.command('agent.list')), error =>
      error.code === 'HERDR_NOT_SUBMITTED' && error.effect === 'not-applied' && error.reason === 'app-version');
    app.owner = async () => ({ labels: { 'herdr.app': JSON.stringify({ ...route, receipts: 1 }) } });
    await assert.rejects(app.tracked('agent.list', null, () => app.command('agent.list')), error =>
      error.code === 'HERDR_NOT_SUBMITTED' && error.effect === 'not-applied' && error.reason === 'storage');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('an unsubmitted refusal recovers as an error and releases its reserved slot after acknowledgement', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-tracked-'));
  try {
    const app = new AppClient(() => {}, 12, 'session-a', { recoveryRoot: root });
    app.journal.limit = 1;
    app.owner = async () => ({});
    let failure;
    try { await app.tracked('agent.send', null, async () => { throw Object.assign(new Error('busy'), { code: 'HERDR_NOT_SUBMITTED', effect: 'not-applied' }); }); }
    catch (error) { failure = error; }
    await assert.rejects(app.tracked('agent.send', null, async () => ({ sent: true })));
    const resumed = new AppClient(() => {}, 13, 'session-a', { recoveryRoot: root });
    resumed.journal.limit = 1;
    resumed.owner = async () => ({});
    const [entry] = await resumed.recoveryList();
    assert.equal(entry.state, 'error');
    assert.equal(entry.error.code, 'HERDR_NOT_SUBMITTED');
    assert.equal(entry.error.effect, 'not-applied');
    assert.equal(entry.recoverable, true);
    assert.equal(entry.id, failure.requestId);
    await resumed.recoveryAck({ items: [{ id: entry.id, revision: entry.revision }] });
    const next = await resumed.tracked('agent.list', null, async () => ({ agents: [] }));
    assert.deepEqual(next.result, { agents: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a compound tracked call reports unknown after a previously admitted mutation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-tracked-'));
  try {
    const app = new AppClient(() => {}, 12, 'session-a', { recoveryRoot: root });
    app.owner = async () => ({});
    let error;
    try { await app.tracked('agent.subagent', null, async () => {
      app.tracking.getStore().admittedMutation = true;
      throw Object.assign(new Error('not submitted'), { code: 'HERDR_NOT_SUBMITTED', effect: 'not-applied' });
    }); } catch (value) { error = value; }
    assert.equal(error.code, 'HERDR_OUTCOME_UNKNOWN');
    assert.equal(error.effect, 'unknown');
    assert.equal((await app.recoveryList())[0].id, error.requestId);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('tracked requests add their durable receipt before dispatch', async () => {
  const core = fixture();
  const prepared = [];
  const result = await requestViaMailbox(core, route, identity, { do: 'agent.list', args: {} }, {
    timeout: 200, pollMs: 1,
    prepareReceipt: async id => { prepared.push(id); return `hr.${'a'.repeat(28)}`; },
  });
  assert.equal(result.marker, 'origin-app');
  const written = core.calls.find(([method, args]) => method === 'doc.set' && Object.keys(args.value.requests).length);
  const [id, request] = Object.entries(written[1].value.requests)[0];
  assert.deepEqual(prepared, [id]);
  assert.equal(request.receipt, `hr.${'a'.repeat(28)}`);
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
});test('only the terminal root or foreground process owns a Herdr terminal', () => {
  assert.equal(ownsTerminal({ pid: 12, foreground: { pid: 30 } }, 12), true);
  assert.equal(ownsTerminal({ pid: 10, foreground: { pid: 12 } }, 12), true);
  // A replicate copy runs behind a wrapper shell that is the foreground process.
  assert.equal(ownsTerminal({ pid: 10, foreground: { pid: 11 } }, 12), false);
  assert.equal(ownsTerminal({ pid: 10 }, 12), false);
});
