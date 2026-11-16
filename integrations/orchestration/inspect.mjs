// Read-only session facts. No Usage extension, model call or terminal rendering.
import { stripVTControlCharacters } from 'node:util';

const clean = text => stripVTControlCharacters(String(text ?? '')).replace(/\s+/gu, ' ').trim();
const textOf = message => (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const clip = (text, limit) => {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.ceil((limit - 3) / 2)).replace(/[\uD800-\uDBFF]$/u, '');
  const tail = text.slice(-Math.floor((limit - 3) / 2)).replace(/^[\uDC00-\uDFFF]/u, '');
  return `${head} … ${tail}`;
};

export function createInspection(ctx) {
  let lastResponse, lastError, pendingQuestion, failed = false;
  const tools = new Map();
  const message = value => {
    if (value.role === 'assistant') {
      const text = clean(textOf(value));
      if (text) lastResponse = text;
      failed = value.stopReason === 'error';
      if (failed) lastError = clean(value.errorMessage) || 'Model response failed';
    } else if (value.role === 'user') { lastError = undefined; failed = false; }
    else if (value.role === 'toolResult' && value.isError) lastError = clean(textOf(value));
  };
  for (const entry of ctx.sessionManager.getBranch()) if (entry.type === 'message') message(entry.message);
  return {
    event(event) {
      switch (event.type) {
        case 'before_agent_start': lastError = undefined; failed = false; break;
        case 'message_end': message(event.message); break;
        case 'tool_execution_start': tools.set(event.toolCallId, { name: event.toolName, args: event.args }); break;
        case 'tool_execution_end':
          tools.delete(event.toolCallId);
          if (event.isError) lastError = clean(textOf(event.result)) || 'Tool execution failed';
          break;
        case 'ui_prompt_start': {
          // Custom question UIs often publish no title. Keep their question and
          // choices, not arbitrary arguments of unrelated tools or tool output.
          const questions = [...tools.values()].flatMap(tool => Array.isArray(tool.args?.questions) ? tool.args.questions : []);
          pendingQuestion = clean([event.title, ...questions.map(question => [question.prompt, ...(question.options ?? []).map(option => option.label)].filter(Boolean).join(' | '))].filter(Boolean).join(' | ')) || event.kind;
          break;
        }
        case 'ui_prompt_end': pendingQuestion = undefined; break;
        case 'agent_settled': tools.clear(); break;
      }
    },
    snapshot() {
      const value = { busy: !ctx.isIdle(), failed, currentTools: [...new Set([...tools.values()].map(tool => clean(tool.name)))], ...(pendingQuestion ? { pendingQuestion } : {}), ...(lastError ? { lastError } : {}), ...(lastResponse ? { lastResponse } : {}) };
      const truncated = [];
      // The serialized budget includes escaping and field names. Preserve both
      // ends of replies (opening context and final result) instead of TUI chrome.
      for (const [key, limit] of [['currentTools', 100], ['pendingQuestion', 280], ['lastError', 180], ['lastResponse', 380]]) {
        if (key === 'currentTools') {
          if (JSON.stringify(value.currentTools).length > limit) { value.currentTools = value.currentTools.slice(0, 3).map(name => clip(name, 24)); truncated.push(key); }
        } else if (value[key]?.length > limit) { value[key] = clip(value[key], limit); truncated.push(key); }
      }
      if (truncated.length) value.truncated = truncated;
      while (JSON.stringify(value).length > 850) {
        const key = ['lastResponse', 'pendingQuestion', 'lastError'].filter(key => value[key]?.length > 16).sort((a, b) => value[b].length - value[a].length)[0];
        if (!key) break;
        value[key] = clip(value[key], value[key].length - 16);
        if (!truncated.includes(key)) truncated.push(key);
        value.truncated = truncated;
      }
      return value;
    },
  };
}
