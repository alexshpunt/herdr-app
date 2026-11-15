import assert from 'node:assert/strict';
import test from 'node:test';
import { openArgs, showsReview } from '../open.mjs';

const review = { url: 'http://localhost:19432/', id: 'pn-1', session: 's1', terminal: 't7', space: 'sp-one' };
test('a button’s review opens in the tab that button opened for the requesting agent', () => {
  assert.deepEqual(openArgs({ ...review, app: 'review', tabName: 'Annotate diff' }), {
    mod: 'plannotator-browser', app: 'review', for: 't7', space: 'sp-one',
    title: 'Annotate diff', props: { url: 'http://localhost:19432/', session: 's1', review: 'pn-1' },
  });
});
test('a review the agent opens itself gets a new Plannotator tab', () => {
  const args = openArgs(review);
  assert.equal(args.app, undefined);
  assert.equal(args.reuse, 'none');
  assert.equal(args.title, 'Plannotator');
  // Without its space, Herdr resolves the terminal id alone.
  assert.equal(openArgs({ ...review, space: undefined }).space, undefined);
});
test('a closed review closes its tab only while the tab still shows it', () => {
  const ls = id => ({ spaces: [{ id: 's', tabs: [{ terminals: [], apps: [{ pane: 'p1', mod: 'plannotator-browser', app: 'review', props: { review: id } }] }] }] });
  assert.equal(showsReview(ls('pn-1'), 'p1', 'pn-1'), true);
  assert.equal(showsReview(ls('pn-2'), 'p1', 'pn-1'), false, 'a later review reused the tab');
  assert.equal(showsReview(ls('pn-1'), 'p9', 'pn-1'), false, 'the tab was closed');
});
