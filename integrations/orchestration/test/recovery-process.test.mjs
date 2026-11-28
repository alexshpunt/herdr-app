import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RecoveryJournal } from '../recovery.mjs';

const moduleUrl = new URL('../recovery.mjs', import.meta.url).href;
function worker(root, limit) {
  const source = `import { RecoveryJournal } from ${JSON.stringify(moduleUrl)};
    const journal = new RecoveryJournal(process.argv[1], 'same-session', { limit: Number(process.argv[2]) });
    try { console.log(await journal.begin('agent.send', 'tool-1')); }
    catch (error) { console.error(error.message); process.exitCode = 1; }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, String(limit)], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: stdout.trim(), stderr }));
  });
}
test('a process exit leaves its request recoverable without holding a journal lock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-recovery-process-'));
  try {
    const result = await worker(root, 2);
    assert.equal(result.code, 0, result.stderr);
    const journal = new RecoveryJournal(root, 'same-session', { limit: 2 });
    const entries = await journal.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, result.stdout);
    assert.equal(entries[0].state, 'unknown');
    assert.equal(entries[0].recoverable, true);
    const second = await journal.begin('agent.list', 'tool-2');
    await journal.fail(second, { effect: 'not-applied' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('competing processes cannot exceed the session journal bound', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-recovery-race-'));
  try {
    const outcomes = await Promise.all([worker(root, 1), worker(root, 1)]);
    assert.equal(outcomes.filter(result => result.code === 0).length, 1);
    const journal = new RecoveryJournal(root, 'same-session', { limit: 1 });
    assert.equal((await journal.list()).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a live owner stays pending and an exited owner becomes recoverable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-recovery-owner-'));
  const source = `import { RecoveryJournal } from ${JSON.stringify(moduleUrl)};
    const journal = new RecoveryJournal(process.argv[1], 'same-session');
    console.log(await journal.begin('agent.send', 'tool-1'));
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  try {
    const id = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', data => { output += data; if (output.includes('\n')) resolve(output.trim()); });
      child.once('error', reject);
      child.once('close', code => reject(new Error(`Owner exited early: ${code} ${stderr}`)));
    });
    const journal = new RecoveryJournal(root, 'same-session');
    let entry = (await journal.list())[0];
    assert.equal(entry.id, id);
    assert.equal(entry.state, 'pending');
    child.kill();
    await exited;
    entry = (await journal.list())[0];
    assert.equal(entry.state, 'unknown');
    assert.equal(entry.recoverable, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
