import assert from 'node:assert/strict';
import test from 'node:test';
import { createInspection } from '../inspect.mjs';

const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' });
test('inspection restores the last reply and reports work, questions and errors without Usage', () => {
  let idle = true;
  const inspection = createInspection({ isIdle: () => idle, sessionManager: { getBranch: () => [{ type: 'message', message: assistant('Merged PR #42') }] } });
  assert.equal(inspection.snapshot().lastResponse, 'Merged PR #42');
  assert.equal(inspection.snapshot().busy, false);
  idle = false;
  inspection.event({ type: 'tool_execution_start', toolCallId: 'one', toolName: 'ask_user', args: { questions: [{ prompt: 'Which release?', options: [{ label: 'Stable' }] }] } });
  inspection.event({ type: 'ui_prompt_start', kind: 'custom' });
  const question = inspection.snapshot();
  assert.equal(question.busy, true);
  assert.deepEqual(question.currentTools, ['ask_user']);
  assert.ok(question.pendingQuestion.includes('Which release?'));
  assert.ok(question.pendingQuestion.includes('Stable'));
  inspection.event({ type: 'ui_prompt_end' });
  inspection.event({ type: 'tool_execution_end', toolCallId: 'one', isError: true, result: { content: [{ type: 'text', text: 'fixture-error' }] } });
  const failed = inspection.snapshot();
  assert.equal(failed.pendingQuestion, undefined);
  assert.deepEqual(failed.currentTools, []);
  assert.equal(failed.lastError, 'fixture-error');
  inspection.event({ type: 'before_agent_start' });
  assert.equal(inspection.snapshot().lastError, undefined);
  inspection.event({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'fixture-quota' } });
  assert.equal(inspection.snapshot().lastError, 'fixture-quota');
});

test('inspection bounds serialized output and flags truncated decision text', () => {
  const inspection = createInspection({ isIdle: () => true, sessionManager: { getBranch: () => [] } });
  inspection.event({ type: 'message_end', message: assistant('Opening '.repeat(300) + 'PR #42 merged') });
  inspection.event({ type: 'ui_prompt_start', title: 'Question '.repeat(300) });
  const snapshot = inspection.snapshot();
  assert.ok(JSON.stringify(snapshot).length <= 850);
  assert.ok(snapshot.lastResponse.endsWith('PR #42 merged'));
  assert.ok(snapshot.truncated.includes('lastResponse'));
  assert.ok(snapshot.truncated.includes('pendingQuestion'));
  assert.ok(!JSON.stringify(snapshot).includes('thinking'));
});
