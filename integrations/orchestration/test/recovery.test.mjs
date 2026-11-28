import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RecoveryJournal } from '../recovery.mjs';

async function withJournal(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-recovery-'));
  try { await run(root); } finally {
    const journal = new RecoveryJournal(root, 'session-a');
    const db = await journal.database();
    const rows = db.prepare('SELECT id FROM requests').all();
    db.close();
    for (const { id } of rows) { journal.active.delete(id); await journal.releaseOwner(id); }
    await rm(root, { recursive: true, force: true });
  }
}

test('results survive reopening and are isolated by Pi session until acknowledged', () => withJournal(async root => {
  const journal = new RecoveryJournal(root, 'session-a');
  const id = await journal.begin('agent.remove', 'tool-a');
  await journal.complete(id, { terminal: 'workstation/t1' });
  assert.deepEqual((await journal.list()).map(({ id, toolCallId, operation, state, result }) => ({ id, toolCallId, operation, state, result })), [
    { id, toolCallId: 'tool-a', operation: 'agent.remove', state: 'result', result: { terminal: 'workstation/t1' } },
  ]);
  assert.deepEqual(await new RecoveryJournal(root, 'session-b').list(), []);
  assert.equal((await new RecoveryJournal(root, 'session-a').list()).length, 1);
  const { revision } = (await journal.list())[0];
  await new RecoveryJournal(root, 'session-b').ack({ items: [{ id, revision }] });
  assert.equal((await journal.list()).length, 1);
  assert.equal((await journal.list())[0].recoverable, true);
  assert.equal((await new RecoveryJournal(root, 'session-a').list())[0].recoverable, true);
  await journal.ack({ items: [{ id, revision }] });
  await journal.ack({ items: [{ id, revision }] });
  assert.deepEqual(await journal.list(), []);
}));

test('an interrupted call is unknown and is never retried on recovery', () => withJournal(async root => {
  const journal = new RecoveryJournal(root, 'session-a');
  const id = await journal.begin('agent.send', 'tool-b');
  journal.active.delete(id); // Simulate the old Pi process exiting.
  await journal.releaseOwner(id);
  const reopened = new RecoveryJournal(root, 'session-a');
  const records = await reopened.list();
  assert.equal(records[0].id, id);
  assert.equal(records[0].state, 'unknown');
  assert.equal(records[0].recoverable, true);
}));

test('acknowledging an older unknown revision cannot hide a later result', () => withJournal(async root => {
  const journal = new RecoveryJournal(root, 'session-a');
  const id = await journal.begin('agent.send', null);
  journal.active.delete(id);
  await journal.releaseOwner(id);
  const unknown = (await journal.list())[0];
  await journal.complete(id, { sent: true });
  await journal.ack({ items: [{ id, revision: unknown.revision }] });
  const result = (await journal.list())[0];
  assert.equal(result.id, id);
  assert.equal(result.state, 'result');
  assert.notEqual(result.revision, unknown.revision);
  await journal.ack({ items: [{ id, revision: result.revision }] });
  assert.deepEqual(await journal.list(), []);
}));

test('a late App receipt creates a new revision after unknown was acknowledged', () => withJournal(async root => {
  const journal = new RecoveryJournal(root, 'session-a');
  const id = await journal.begin('agent.send', null);
  await journal.addRequest(id, { id: 'request-1', receipt: 'hr.test' });
  await journal.fail(id, { code: 'HERDR_OUTCOME_UNKNOWN', effect: 'unknown' });
  let receipt = { id: 'request-1', state: 'pending' };
  const resolve = async () => [receipt];
  const unknown = (await journal.list(resolve))[0];
  assert.equal(unknown.recoverable, true);
  await journal.ack({ items: [{ id, revision: unknown.revision }] });
  assert.deepEqual(await journal.list(resolve), []);
  receipt = { id: 'request-1', state: 'done', result: { sent: true } };
  const late = (await journal.list(resolve))[0];
  assert.equal(late.recoverable, true);
  assert.notEqual(late.revision, unknown.revision);
  assert.deepEqual(late.evidence[0].result, { sent: true });
}));

test('an interrupted direct command recovers its durable App result', () => withJournal(async root => {
  const journal = new RecoveryJournal(root, 'session-a', { limit: 1 });
  const id = await journal.begin('agent.send', 'tool-a');
  await journal.addRequest(id, { id: 'request-1', receipt: 'hr.test', wire: { do: 'agent.send', args: {} } });
  journal.active.delete(id);
  await journal.releaseOwner(id);
  const resolve = async () => [{ id: 'request-1', state: 'done', result: { sent: true } }];
  const recovered = (await journal.list(resolve))[0];
  assert.equal(recovered.state, 'result');
  assert.deepEqual(recovered.result, { sent: true });
  assert.equal(recovered.recoverable, true);
  await journal.ack({ items: [{ id, revision: recovered.revision }] }, resolve);
  assert.deepEqual(await journal.list(resolve), []);
  await journal.cleanupComplete('request-1');
  await journal.begin('agent.list', null);
}));

test('a later failure cannot replace an already recorded result', () => withJournal(async root => {
  const journal = new RecoveryJournal(root, 'session-a');
  const id = await journal.begin('agent.send', null);
  await journal.complete(id, { sent: true });
  await journal.fail(id, { code: 'HERDR_OUTCOME_UNKNOWN', effect: 'unknown' });
  const entry = (await journal.list())[0];
  assert.equal(entry.state, 'result');
  assert.deepEqual(entry.result, { sent: true });
}));

test('receipt cleanup survives a process restart after result acknowledgement', () => withJournal(async root => {
  const journal = new RecoveryJournal(root, 'session-a');
  const id = await journal.begin('agent.send', 'tool-a');
  await journal.addRequest(id, { id: 'request-1', receipt: 'hr.test' });
  await journal.complete(id, { sent: true });
  const { revision } = (await journal.list())[0];
  await journal.ack({ items: [{ id, revision }] });
  const reopened = new RecoveryJournal(root, 'session-a');
  assert.deepEqual((await reopened.cleanupPending()).map(row => ({ ...row })), [{ id: 'request-1', receipt: 'hr.test' }]);
  const limited = new RecoveryJournal(root, 'session-a', { limit: 1 });
  await assert.rejects(limited.begin('agent.send', null));
  await reopened.cleanupComplete('request-1');
  assert.deepEqual(await reopened.cleanupPending(), []);
}));

test('concurrent acknowledgements cannot release a slot owned by a new request', () => withJournal(async root => {
  const journal = new RecoveryJournal(root, 'session-a', { limit: 1 });
  const id = await journal.begin('agent.send', null);
  await journal.complete(id, { sent: true });
  const { revision } = (await journal.list())[0];
  const item = { items: [{ id, revision }] };
  const outcomes = await Promise.allSettled([journal.ack(item), journal.ack(item)]);
  assert.ok(outcomes.some(result => result.status === 'fulfilled'));
  const next = await journal.begin('agent.send', null);
  await assert.rejects(journal.begin('agent.send', null));
  assert.ok((await journal.list()).some(entry => entry.id === next));
}));

test('a full recovery journal refuses before invoking a new operation', () => withJournal(async root => {
  const journal = new RecoveryJournal(root, 'session-a', { limit: 2 });
  const first = await journal.begin('agent.send', null);
  const second = await journal.begin('agent.remove', null);
  await journal.complete(first, { sent: true });
  await assert.rejects(journal.begin('agent.send', null));
  const record = (await journal.list()).find(entry => entry.id === first);
  await journal.ack({ items: [{ id: first, revision: record.revision }] });
  const third = await journal.begin('agent.send', null);
  assert.notEqual(third, second);
}));

test('inactive results and refusals can be delivered when no tool result marker survives', () => withJournal(async root => {
  const journal = new RecoveryJournal(root, 'session-a');
  const resultId = await journal.begin('agent.send', null);
  await journal.complete(resultId, { sent: true });
  const errorId = await journal.begin('agent.remove', null);
  await journal.fail(errorId, { code: 'HERDR_NOT_SUBMITTED', effect: 'not-applied' });
  const entries = await journal.list();
  assert.equal(entries.find(entry => entry.id === resultId).recoverable, true);
  assert.equal(entries.find(entry => entry.id === errorId).recoverable, true);
}));

test('an acknowledged unknown is reclaimed only after every receipt is final', () => withJournal(async root => {
  const journal = new RecoveryJournal(root, 'session-a', { limit: 1 });
  const id = await journal.begin('agent.subagent', null);
  await journal.addRequest(id, { id: 'request-1', receipt: 'hr.one', wire: { do: 'tab.new' } });
  await journal.addRequest(id, { id: 'request-2', receipt: 'hr.two', wire: { do: 'agent.inspect' } });
  await journal.fail(id, { code: 'HERDR_OUTCOME_UNKNOWN', effect: 'unknown' });
  let receipt = [ { id: 'request-1', state: 'done', result: { error: 'failure' } }, { id: 'request-2', state: 'pending' } ];
  const resolve = async () => receipt;
  let event = (await journal.list(resolve))[0];
  await journal.ack({ items: [{ id, revision: event.revision }] }, resolve);
  await assert.rejects(journal.begin('agent.list', null));
  receipt = [ receipt[0], { id: 'request-2', state: 'done', result: { ok: true } } ];
  event = (await journal.list(resolve))[0];
  assert.equal(event.state, 'unknown');
  await journal.ack({ items: [{ id, revision: event.revision }] }, resolve);
  assert.deepEqual(await journal.list(resolve), []);
  const cleanup = await journal.cleanupPending();
  assert.equal(cleanup.length, 2);
  for (const request of cleanup) await journal.cleanupComplete(request.id);
  await journal.begin('agent.list', null);
}));

test('an acknowledged direct terminal error is reclaimed without claiming success', () => withJournal(async root => {
  const journal = new RecoveryJournal(root, 'session-a');
  const id = await journal.begin('agent.send', null);
  await journal.addRequest(id, { id: 'request-1', receipt: 'hr.one', wire: { do: 'agent.send' } });
  await journal.fail(id, { code: 'HERDR_OUTCOME_UNKNOWN', effect: 'unknown' });
  const resolve = async () => [{ id: 'request-1', state: 'done', result: { error: 'failure' } }];
  const event = (await journal.list(resolve))[0];
  assert.equal(event.state, 'unknown');
  await journal.ack({ items: [{ id, revision: event.revision }] }, resolve);
  assert.deepEqual(await journal.list(resolve), []);
  assert.equal((await journal.cleanupPending()).length, 1);
}));

test('a reused process id cannot keep an interrupted request pending', () => withJournal(async root => {
  const journal = new RecoveryJournal(root, 'session-a');
  const id = await journal.begin('agent.send', null);
  const db = await journal.database();
  try {
    const row = db.prepare('SELECT data FROM requests WHERE id = ?').get(id);
    const data = JSON.parse(row.data);
    data.ownerPid = process.ppid; // An unrelated, still-running process has this PID.
    db.prepare('UPDATE requests SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
  } finally { db.close(); }
  journal.active.delete(id);
  await journal.releaseOwner(id); // Simulate the original owner's process exiting.
  const entry = (await new RecoveryJournal(root, 'session-a').list())[0];
  assert.equal(entry.state, 'unknown');
  assert.equal(entry.recoverable, true);
}));

test('a live owner lock keeps a request pending independently of process id', () => withJournal(async root => {
  const journal = new RecoveryJournal(root, 'session-a');
  const id = await journal.begin('agent.send', null);
  journal.active.delete(id); // Simulate another Pi process looking at the journal.
  assert.equal((await new RecoveryJournal(root, 'session-a').list())[0].state, 'pending');
  await journal.releaseOwner(id);
}));
