import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Exercise the shipped mod's start sequence. The native bridge and host are
// supplied here; real HWND ownership is checked by the Windows live test.
const bridge = { shown: false, states: [], lease: null };
globalThis.__forkReloadTest = bridge;
const modules = {
  'gpui-kit': 'export class View {}; export const div = () => {};',
  'gpui-base': 'export const v_flex = () => {};',
  'herdr-browser': `
    export const NativeApp = () => {};
    export function NativeAppState(key) {
      const host = globalThis.__forkReloadTest;
      const state = { key, opens: [], reopens: 0, shown: () => host.shown,
        error: () => null, open(value) { this.opens.push(value); },
        reopen() { this.reopens++; } };
      host.states.push(state);
      return state;
    }`,
  'herdr': `
    const host = globalThis.__forkReloadTest;
    export const props = () => ({ pane: 'diff' });
    export const env = name => name === 'LOCALAPPDATA' ? 'C:/isolated' : null;
    export const shared = () => host.lease;
    export const setShared = (_key, value) => { host.lease = value; };
    export const theme = () => ({}), focused = () => null,
      nextCommand = () => {}, readTextFile = () => {}, writeTextFile = () => {},
      listFolder = () => {}, appHome = () => '', exec = () => {};`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier in modules) return { url: `fork-test:${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('fork-test:')) return { format: 'module', source: modules[url.slice(10)], shortCircuit: true };
    return next(url, context);
  },
});
const { default: ForkApp } = await import('../defaults/mods/fork/main.js');
hooks.deregister();

function setup(shown, rendered = true) {
  Object.assign(bridge, { shown, states: [], lease: null });
  const app = new ForkApp();
  Object.assign(app, { folder: 'C:\\repo', app: null, rendered, waiting: false });
  let prepared = 0;
  app.prepare = async () => { prepared++; };
  const sleepers = [];
  const cx = { notify() {}, sleep: ms => ms === 0 ? Promise.resolve() : new Promise(resolve => sleepers.push(resolve)) };
  return { app, cx, sleepers, prepared: () => prepared };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('a reloaded Fork takes its window before a busy launch lease, even in a hidden pane', async () => {
  const { app, cx, sleepers, prepared } = setup(true, false);
  const other = { id: 'other-pane', until: Date.now() + 60_000 };
  bridge.lease = other;
  let finished = false;
  const start = app.start(cx).then(() => { finished = true; });
  await flush();
  assert.equal(bridge.states.length, 1);
  assert.equal(app.app, bridge.states[0]);
  assert.equal(finished, true);
  assert.equal(sleepers.length, 0);
  assert.equal(prepared(), 0);
  assert.equal(bridge.lease, other);
  assert.equal(app.app.opens.length, 1); // Keep a description for a later reopen.
  assert.equal(app.app.reopens, 0);
  await start;
});

test('a fresh Fork publishes its state but waits for visibility, the lease and preparation before launch', async () => {
  const { app, cx, sleepers, prepared } = setup(false, false);
  bridge.lease = { id: 'other', until: Date.now() + 60_000 };
  const start = app.start(cx);
  await flush();
  assert.equal(bridge.states.length, 1);
  assert.equal(app.app, bridge.states[0]);
  assert.equal(app.app.opens.length, 0);
  assert.equal(prepared(), 0);
  app.rendered = true;
  sleepers.shift()();
  await flush();
  assert.equal(app.waiting, true);
  assert.equal(prepared(), 0);
  bridge.lease = null;
  sleepers.shift()();
  await flush();
  assert.equal(prepared(), 1);
  sleepers.shift()();
  await flush();
  assert.equal(app.app.opens.length, 1);
  assert.equal(app.app.reopens, 0);
  bridge.shown = true;
  sleepers.shift()();
  await start;
  assert.equal(bridge.lease, null);
});

test('Open again still prepares and reopens the existing state', async () => {
  const { app, cx, sleepers, prepared } = setup(false);
  const existing = { shown: () => bridge.shown, error: () => null, reopens: 0, reopen() { this.reopens++; } };
  app.app = existing;
  const start = app.start(cx);
  await flush();
  assert.equal(prepared(), 1);
  sleepers.shift()();
  await flush();
  assert.equal(existing.reopens, 1);
  assert.equal(bridge.states.length, 0);
  bridge.shown = true;
  sleepers.shift()();
  await start;
  assert.equal(bridge.lease, null);
});
