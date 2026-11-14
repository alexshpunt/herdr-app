import assert from 'node:assert/strict';
import test from 'node:test';
import { findOriginPane, showsReview } from '../open.mjs';

const spaces = [
  { id: 'laptop/sp-one', tabs: [{ terminals: [{ terminal: 'laptop/t7', pane: 'laptop/p1' }] }] },
  { id: 'worker/sp-two', tabs: [{ terminals: [{ terminal: 'worker/t7', pane: 'worker/p2' }] }] },
];
test('a review opens in the requester’s pane even when terminal ids repeat on another machine', () => {
  assert.deepEqual(findOriginPane({ spaces }, { address: 't7', labels: { 'herdr.space': 'sp-one' } }), { space: 'laptop/sp-one', pane: 'laptop/p1' });
  assert.deepEqual(findOriginPane({ spaces }, { address: 't7', labels: { 'herdr.space': 'sp-two' } }), { space: 'worker/sp-two', pane: 'worker/p2' });
});
test('unknown and ambiguous origins never fall back to the active agent', () => {
  assert.equal(findOriginPane({ spaces }, { address: 't7', labels: {} }), undefined);
  assert.equal(findOriginPane({ spaces }, { address: 't9', labels: { 'herdr.space': 'sp-one' } }), undefined);
  const duplicate = [...spaces, { id: 'other/sp-one', tabs: [{ terminals: [{ terminal: 'other/t7', pane: 'other/p3' }] }] }];
  assert.equal(findOriginPane({ spaces: duplicate }, { address: 't7', labels: { 'herdr.space': 'sp-one' } }), undefined);
});
test('a closed review closes its app only while the app still shows it', () => {
  const ls = review => ({ spaces: [{ id: 's', tabs: [{ terminals: [{ terminal: 't7', pane: 'p1', apps: [{ id: 'a1', mod: 'plannotator-browser', props: { review } }] }] }] }] });
  assert.equal(showsReview(ls('pn-1'), 'a1', 'pn-1'), true);
  assert.equal(showsReview(ls('pn-2'), 'a1', 'pn-1'), false, 'a later review reused the app');
  assert.equal(showsReview(ls('pn-1'), 'a9', 'pn-1'), false, 'the app was closed');
});
