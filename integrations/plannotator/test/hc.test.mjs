import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHc } from '../hc.mjs';

test('hc is found on PATH first', () => {
  const found = new Set(['/opt/bin/hc', '/home/u/.local/bin/hc']);
  assert.equal(resolveHc({ env: { PATH: '/usr/bin:/opt/bin' }, home: '/home/u', platform: 'linux', exists: f => found.has(f) }), '/opt/bin/hc');
});

test('a Pi started without a login shell finds hc in ~/.local/bin', () => {
  const found = new Set(['/home/u/.local/bin/hc']);
  assert.equal(resolveHc({ env: { PATH: '/usr/bin:/bin' }, home: '/home/u', platform: 'linux', exists: f => found.has(f) }), '/home/u/.local/bin/hc');
});

test('Windows looks in herdr-core\'s install folder', () => {
  const file = 'C:\\Users\\u\\AppData\\Local\\Programs\\herdr-core\\hc.exe';
  assert.equal(resolveHc({ env: { PATH: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, home: 'C:\\Users\\u', platform: 'win32', exists: f => f === file }), file);
});

test('HC_BIN wins, and a missing hc stays bare', () => {
  assert.equal(resolveHc({ env: { HC_BIN: '/x/hc', PATH: '/opt/bin' }, home: '/h', platform: 'linux', exists: () => true }), '/x/hc');
  assert.equal(resolveHc({ env: {}, home: '/h', platform: 'linux', exists: () => false }), 'hc');
});
