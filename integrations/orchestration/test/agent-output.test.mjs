import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAgentOutcome, formatOrigin } from '../index.ts';

test('the agent context keeps usable addresses without process metadata', () => {
  const text = formatOrigin({ terminal: 'fixture/t9', space: 'fixture/space9', pid: 123456, session: 'private-session', tab: 'private-tab', machine: 'private-machine' });
  assert.ok(text.includes('fixture/t9'));
  assert.ok(text.includes('fixture/space9'));
  for (const value of ['123456', 'private-session', 'private-tab', 'private-machine', '{', '}']) assert.ok(!text.includes(value));
});

test('agent launch results expose addresses, not internal receipt details', () => {
  const receipt = { outcome: 'model-failed', name: 'fixture-name', terminal: 'fixture/t9', detail: 'fixture-reason', pid: 123456, session: 'private-session', requestId: 'private-request', fingerprint: 'private-fingerprint', attempts: [{ model: 'private-model' }], retainedPrimary: { terminal: 'fixture/t8', pid: 654321 } };
  const text = formatAgentOutcome(receipt);
  for (const value of ['fixture-name', 'fixture/t9', 'fixture/t8']) assert.ok(text.includes(value));
  for (const value of ['fixture-reason', '123456', '654321', 'private-session', 'private-request', 'private-fingerprint', 'private-model', '{', '}']) assert.ok(!text.includes(value));
});

test('successful launches preserve the agent address without repeating the task payload', () => {
  const text = formatAgentOutcome({ outcome: 'started', name: 'fixture-name', terminal: 'fixture/t9', detail: 'private-task', attempts: [{ session: 'private-session' }] });
  assert.ok(text.includes('fixture-name'));
  assert.ok(text.includes('fixture/t9'));
  for (const value of ['private-task', 'private-session', '{', '}']) assert.ok(!text.includes(value));
});

test('an unconfirmed launch directs inspection without exposing the receipt', () => {
  const text = formatAgentOutcome({ outcome: 'unknown', detail: 'fixture-reason', requestId: 'private-request' });
  assert.ok(!text.includes('fixture-reason'));
  assert.ok(text.includes('herdr:'));
  assert.ok(!text.includes('private-request'));
});

test('an exited agent points to its terminal without leaking its captured screen', () => {
  const text = formatAgentOutcome({ outcome: 'exited', terminal: 'fixture/t9', detail: 'Pi exited during startup with model private-model and thinking high. private-screen' });
  assert.ok(text.includes('fixture/t9'));
  assert.ok(!text.includes('private-model'));
  assert.ok(!text.includes('private-screen'));
});

test('failure output does not relay embedded JSON or stack traces', () => {
  for (const detail of [
    'Request failed: {"internal":"private-json"}',
    'Request failed\n    at privateStack (/internal/file.js:1:2)',
    'Request failed at privateStack (/internal/file.js:1:2)',
  ]) {
    const text = formatAgentOutcome({ outcome: 'model-failed', terminal: 'fixture/t9', detail });
    assert.ok(text.includes('fixture/t9'));
    assert.ok(!text.includes('private-json'));
    assert.ok(!text.includes('privateStack'));
  }
});
