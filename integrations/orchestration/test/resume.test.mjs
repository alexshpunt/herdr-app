import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createResume, resumeArgv } from '../resume.mjs';

const env = { HC_TERMINAL_ID: 't7', HC_TERMINAL_SOCKET: '/sock' };
const flags = { 'herdr-workflow-model': 'p/m', 'herdr-workflow-thinking': 'high', 'herdr-depth': undefined };
function setup({ record = { pid: 42, keep: true }, processObject = new EventEmitter() } = {}) {
  const calls = [];
  const core = async (method, params) => { calls.push([method, params]); return method === 'terminal.get' ? record : { keep: true, recover: params.recover }; };
  processObject.pid ??= 42;
  processObject.kill ??= () => {};
  const resume = createResume({ pid: 42, env, argv: ['/node', '/pi/cli.js', '--model', 'p/m', 'Do the task'], execPath: '/node', processObject, core });
  return { resume, calls, keeps: () => calls.filter(([method]) => method === 'terminal.keep').map(([, params]) => params.recover), processObject };
}

test('the recovery command reopens the session file with Herdr flags and never the task message', () => {
  assert.deepEqual(resumeArgv({ execPath: '/node', script: '/pi/cli.js', sessionFile: '/s/a.jsonl', flags }),
    ['/node', '/pi/cli.js', '--session', '/s/a.jsonl', '--herdr-workflow-model', 'p/m', '--herdr-workflow-thinking', 'high']);
  assert.equal(resumeArgv({ execPath: '/node', script: '/pi/cli.js', sessionFile: undefined }), undefined, 'an unsaved, in-memory session has nothing to reopen');
});

test('it follows the session the Pi shows and calls the core only on a change', async () => {
  const { resume, keeps } = setup();
  await resume.update({ sessionFile: '/s/a.jsonl', flags: {} });
  await resume.update({ sessionFile: '/s/a.jsonl', flags: {} });
  await resume.update({ sessionFile: '/s/b.jsonl', flags: {} });
  assert.deepEqual(keeps(), [['/node', '/pi/cli.js', '--session', '/s/a.jsonl'], ['/node', '/pi/cli.js', '--session', '/s/b.jsonl']]);
});

test('a nested Pi or a terminal the App does not keep is left alone', async () => {
  for (const record of [{ pid: 1, foreground: { pid: 2 }, keep: true }, { pid: 42, keep: false }]) {
    const { resume, keeps } = setup({ record });
    await resume.update({ sessionFile: '/s/a.jsonl', flags: {} });
    assert.deepEqual(keeps(), []);
  }
  const { resume, keeps } = setup({ record: { pid: 1, foreground: { pid: 42 }, keep: true } });
  await resume.update({ sessionFile: '/s/a.jsonl', flags: {} });
  assert.equal(keeps().length, 1, 'a Pi started from the shell owns the terminal as its foreground');
});

test('a deliberate quit forgets the command; a reload, a session switch or a signal keeps it', async () => {
  for (const reason of ['reload', 'new', 'resume', 'fork']) {
    const { resume, keeps } = setup();
    await resume.update({ sessionFile: '/s/a.jsonl', flags: {} });
    await resume.shutdown(reason);
    assert.equal(keeps().length, 1, reason);
  }
  const quit = setup();
  await quit.resume.update({ sessionFile: '/s/a.jsonl', flags: {} });
  await quit.resume.shutdown('quit');
  assert.deepEqual(quit.keeps().at(-1), []);

  const processObject = new EventEmitter();
  processObject.on('SIGTERM', () => {}); // Pi's own handler
  const signalled = setup({ processObject });
  await signalled.resume.update({ sessionFile: '/s/a.jsonl', flags: {} });
  processObject.emit('SIGTERM');
  await signalled.resume.shutdown('quit');
  assert.equal(signalled.keeps().length, 1, 'a shutdown signal keeps it for the coming loss');
});

test('alone, the signal listener lets the signal end the process', () => {
  const processObject = new EventEmitter();
  const killed = [];
  processObject.pid = 9; processObject.kill = (pid, signal) => killed.push([pid, signal]);
  setup({ processObject });
  processObject.emit('SIGHUP');
  assert.deepEqual(killed, [[9, 'SIGHUP']]);
  assert.equal(processObject.listenerCount('SIGHUP'), 0);
});

test('outside a Herdr terminal it does nothing', async () => {
  const calls = [];
  const resume = createResume({ env: {}, processObject: new EventEmitter(), core: async (...args) => { calls.push(args); } });
  await resume.update({ sessionFile: '/s/a.jsonl', flags: {} });
  await resume.shutdown('quit');
  assert.deepEqual(calls, []);
});
