import assert from 'node:assert/strict';
import test from 'node:test';
import { modelChoices, currentModelLabel } from '../defaults/frame/workflow/models.js';

const catalog = { models: [
  { id: 'provider/model-a', name: 'Model A' },
  { id: 'other/model-b', name: 'Model B' },
] };

test('model dropdown choices come only from the current Pi picker', () => {
  assert.deepEqual(modelChoices(null), []);
  assert.deepEqual(modelChoices({ models: [] }), []);
  assert.deepEqual(modelChoices(catalog, 'OTHER'), [{ id: 'other/model-b', name: 'Model B' }]);
  assert.deepEqual(modelChoices(catalog, 'model a'), [{ id: 'provider/model-a', name: 'Model A' }]);
  assert.deepEqual(modelChoices(catalog, 'unavailable'), []);
});

test('fallback dropdown adds an explicit disabled option without inventing models', () => {
  assert.deepEqual(modelChoices(null, '', true), [{ id: null, name: 'No fallback' }]);
  assert.deepEqual(modelChoices(catalog, 'no fallback', true), [{ id: null, name: 'No fallback' }]);
  assert.equal(modelChoices(catalog, '', false).length, 2);
});

test('manual provider/model entry works without a Pi catalog in either picker', () => {
  for (const source of [null, { models: [], error: 'offline' }, catalog]) {
    for (const fallback of [false, true]) {
      const choices = modelChoices(source, ' custom/new-model:variant ', fallback);
      assert.equal(choices.length, 1);
      assert.equal(choices[0].id, 'custom/new-model:variant');
      assert.equal(choices[0].manual, true);
    }
  }
  assert.equal(modelChoices(catalog, 'provider/model-a').length, 1);
  for (const query of ['provider/', '/model', 'no provider', 'p/model;exit']) {
    assert.deepEqual(modelChoices(null, query), []);
  }
});
test('missing configured models stay visible without claiming availability', () => {
  assert.equal(currentModelLabel(catalog, 'provider/model-a'), 'Model A');
  assert.equal(currentModelLabel(catalog, 'provider/old-model'), 'provider/old-model');
  assert.equal(currentModelLabel(null, null, true), 'No fallback');
});
