import assert from 'node:assert/strict';
import test from 'node:test';
import { createInspection } from '../inspect.mjs';

const entry = (role, content, extra = {}, at = '2026-01-01T00:00:00Z') => ({ type: 'message', timestamp: at, message: { role, content, ...extra } });
const text = value => ({ type: 'text', text: value });
const call = (id, args = { command: 'echo fixture\nsecond line' }) => ({ type: 'toolCall', id, name: 'bash', arguments: args });
const setup = branch => createInspection({ isIdle: () => true, sessionManager: { getBranch: () => branch } });

test('timeline starts at the last reply part and preserves subsequent steps in order', () => {
  const branch = [entry('assistant', [text('old'), call('old')]), entry('assistant', [{ type: 'thinking', thinking: 'before reply' }, text('latest\nreply'), { type: 'thinking', thinking: 'next step' }, call('failed'), call('running'), call('done')]), entry('toolResult', [text('fixture failure')], { toolCallId: 'failed', isError: true })];
  const inspection = setup(branch);
  inspection.event({ type: 'tool_execution_start', toolCallId: 'running', toolName: 'bash', args: {} });
  const result = inspection.timeline();
  assert.deepEqual(result.events.map(event => event.kind), ['reply', 'reasoning', 'call', 'call', 'call']);
  assert.equal(result.events[0].text, 'latest\nreply');
  assert.equal(result.events[1].text, 'next step');
  assert.deepEqual(result.events.slice(2).map(event => event.state), ['failed', 'running', 'done']);
  assert.equal(result.events[2].summary, 'echo fixture');
  assert.equal(result.events[0].at, branch[1].timestamp);
  assert.equal(result.lastError, 'fixture failure');
});

test('timeline without a reply keeps only the newest five calls and three reasoning parts', () => {
  const parts = Array.from({ length: 9 }, (_, i) => [{ type: 'thinking', thinking: `reason ${i}` }, call(String(i), { path: `file-${i}` })]).flat();
  const result = setup([entry('assistant', parts)]).timeline();
  assert.deepEqual(result.omitted, { calls: 4, reasoning: 6 });
  assert.equal(result.events.length, 8);
  assert.deepEqual(result.events.filter(event => event.kind === 'call').map(event => event.summary), ['file-4', 'file-5', 'file-6', 'file-7', 'file-8']);
});

test('timeline bounds escaped unicode transport while retaining both ends of a reply', () => {
  const result = setup([entry('assistant', [text('opening ' + '\u0000💡'.repeat(15000) + ' final result'), { type: 'thinking', thinking: 'x'.repeat(1000) }, call('one', { query: 'y'.repeat(1000) })])]).timeline();
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 48 * 1024);
  const reply = result.events[0].text;
  assert.ok(reply.length <= 12000 && reply.isWellFormed());
  assert.ok(reply.startsWith('opening ') && reply.endsWith(' final result'));
  assert.ok(result.events[1].text.length <= 600);
  assert.ok(result.events[2].summary.length <= 160);
});

test('live question and error tracking survives the new timeline contract', () => {
  const inspection = setup([]);
  inspection.event({ type: 'tool_execution_start', toolCallId: 'one', toolName: 'ask_user', args: { questions: [{ prompt: 'fixture choice', options: [{ label: 'fixture option' }] }] } });
  inspection.event({ type: 'ui_prompt_start', title: 'fixture choice' });
  assert.equal(inspection.timeline().pendingQuestion, 'fixture choice | fixture option');
  inspection.event({ type: 'ui_prompt_end' });
  assert.equal(inspection.timeline().pendingQuestion, undefined);
  inspection.event({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'fixture quota' } });
  assert.equal(inspection.timeline().failed, true);
  assert.equal(inspection.timeline().lastError, 'fixture quota');
  inspection.event({ type: 'before_agent_start' });
  assert.equal(inspection.timeline().failed, false);
  assert.equal(inspection.timeline().lastError, undefined);
});

test('history indexes all branch parts and pages exclusively before the requested index', () => {
  const branch = [entry('user', [text('request')]), entry('assistant', [{ type: 'thinking', thinking: 'plan' }, call('one', { path: 'fixture' }), text('reply')]), entry('toolResult', [text('result')], { toolName: 'bash', toolCallId: 'one' })];
  const inspection = setup(branch);
  assert.deepEqual(inspection.history({}).items.map(item => [item.index, item.kind]), [[0, 'user'], [1, 'reasoning'], [2, 'call'], [3, 'reply'], [4, 'result']]);
  assert.deepEqual(inspection.history({ before: 4, limit: 2 }).items.map(item => item.index), [2, 3]);
  assert.equal(inspection.history({ before: 0 }).items.length, 0);
  assert.equal(inspection.history({}).items[2].text, 'bash {"path":"fixture"}');
});

test('history searches full text, including cut-away tool results, newest first', () => {
  const branch = [entry('user', [text('Needle older')]), entry('toolResult', [text('x'.repeat(6000) + 'needle' + 'y'.repeat(6000))], { toolName: 'read' })];
  const inspection = setup(branch);
  const result = inspection.history({ query: 'NEEDLE' });
  assert.deepEqual(result.matches.map(item => item.index), [1, 0]);
  assert.ok(result.matches[0].text.includes('needle'));
  assert.ok(result.matches[0].text.length <= 430);
  assert.equal(inspection.history({ query: 'NEEDLE', caseSensitive: true }).matches.length, 0);
  assert.ok(inspection.history({}).items[1].text.length <= 4000);
  assert.ok(Buffer.byteLength(JSON.stringify(inspection.history({ limit: 50 }))) <= 120 * 1024);
});
