import assert from 'node:assert/strict';
import test from 'node:test';
import { reachable } from '../request.mjs';

const label = { pid: 42, socket: 'pipe', session: 's1' };
const terminal = extra => ({ state: 'live', labels: { 'herdr.plannotator': JSON.stringify(label) }, ...extra });

test('annotations reach a root Pi before foreground sampling and while it runs a child tool', () => {
  assert.deepEqual(reachable(terminal({ pid: 42, foreground: null })), label);
  assert.deepEqual(reachable(terminal({ pid: 42, foreground: { pid: 88 } })), label);
});

test('annotations reach a foreground Pi but not a nested or ended process', () => {
  assert.deepEqual(reachable(terminal({ pid: 1, foreground: { pid: 42 } })), label);
  assert.equal(reachable(terminal({ pid: 1, foreground: { pid: 88 } })), null);
  assert.equal(reachable(terminal({ pid: 42, state: 'exited' })), null);
  assert.equal(reachable(terminal({ pid: 42, labels: { 'herdr.plannotator': 'not-json' } })), null);
});
