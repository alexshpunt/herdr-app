import assert from 'node:assert/strict';
import test from 'node:test';
import { findOriginPane, reviewKey } from '../open.mjs';

const spaces = [
  { id: 'laptop/sp-one', tabs: [{ terminals: [{ terminal: 'laptop/t7', pane: 'laptop/p1' }] }] },
  { id: 'worker/sp-two', tabs: [{ terminals: [{ terminal: 'worker/t7', pane: 'worker/p2' }] }] },
];
test('the core space identifies the requester even when terminal ids repeat on another machine', () => {
  assert.equal(findOriginPane({ spaces }, { address: 't7', labels: { 'herdr.space': 'sp-one' } }), 'laptop/p1');
  assert.equal(findOriginPane({ spaces }, { address: 't7', labels: { 'herdr.space': 'sp-two' } }), 'worker/p2');
});
test('unknown and ambiguous origins never fall back to the active agent', () => {
  assert.equal(findOriginPane({ spaces }, { address: 't7', labels: {} }), undefined);
  assert.equal(findOriginPane({ spaces }, { address: 't9', labels: { 'herdr.space': 'sp-one' } }), undefined);
});
test('concurrent reviews and sessions have independent cleanup records', () => {
  assert.notEqual(reviewKey('session-a', 'http://localhost:1234'), reviewKey('session-b', 'http://localhost:1234'));
  assert.notEqual(reviewKey('session-a', 'http://localhost:1234'), reviewKey('session-a', 'http://localhost:5678'));
  assert.equal(reviewKey('session-a', 'http://localhost:1234'), reviewKey('session-a', 'http://localhost:1234'));
});
