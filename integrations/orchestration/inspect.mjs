// Read-only session facts. No Usage extension, model call or terminal rendering.
import { stripVTControlCharacters } from 'node:util';

const clean = text => stripVTControlCharacters(String(text ?? '')).replace(/\s+/gu, ' ').trim();
const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const clip = (text, limit) => {
  if (text.length <= limit) return text;
  const marker = ' [… cut …] ';
  const head = text.slice(0, Math.ceil((limit - marker.length) / 2)).replace(/[\uD800-\uDBFF]$/u, '');
  const tail = text.slice(-Math.floor((limit - marker.length) / 2)).replace(/^[\uDC00-\uDFFF]/u, '');
  return `${head}${marker}${tail}`;
};

export function validateHistoryParams(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid history parameters');
  const { query, caseSensitive, before, limit } = params;
  if (query !== undefined && (typeof query !== 'string' || query.length > 200)) throw new Error('History query must be a string of at most 200 characters');
  if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') throw new Error('History caseSensitive must be a boolean');
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new Error('History before must be a non-negative integer');
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) throw new Error('History limit must be 1–50');
  return { query, caseSensitive: caseSensitive ?? false, before, limit: limit ?? 20 };
}

function* branchItems(branch) {
  let index = 0;
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const { message } = entry;
    const at = entry.timestamp;
    if (message.role === 'user' || message.role === 'toolResult') {
      yield { index: index++, at, kind: message.role === 'user' ? 'user' : 'result', ...(message.toolName ? { tool: message.toolName } : {}), text: textOf(message) };
    } else if (message.role === 'assistant') {
      for (const part of message.content ?? []) {
        if (part.type === 'text') yield { index: index++, at, kind: 'reply', text: part.text };
        else if (part.type === 'thinking') yield { index: index++, at, kind: 'reasoning', text: part.thinking };
        else if (part.type === 'toolCall') yield { index: index++, at, kind: 'call', tool: part.name, text: `${part.name} ${JSON.stringify(part.arguments)}` };
      }
    }
  }
}

function callSummary(tool, args = {}) {
  if (tool === 'codemode') return '';
  const value = [args.command, args.path, args.file, args.query, args.url, args.pattern, args.prompt, args.questions?.[0]?.prompt, args.code, ...Object.values(args)].find(value => typeof value === 'string');
  return clip(clean(value?.split(/\r?\n/u)[0]), 160);
}

// Escaped control characters can make JSON much larger than its source strings.
function boundTimeline(value) {
  while (Buffer.byteLength(JSON.stringify(value)) > 48 * 1024) {
    const candidates = [...value.events.filter(event => event.text).map(event => [event, 'text']), ...['pendingQuestion', 'lastError'].filter(key => value[key]).map(key => [value, key])];
    candidates.sort(([a, ak], [b, bk]) => b[bk].length - a[ak].length);
    const [target, key] = candidates[0];
    target[key] = clip(target[key], Math.max(32, Math.floor(target[key].length * 0.75)));
  }
  return value;
}

export function createInspection(ctx) {
  let lastError, pendingQuestion, failed = false;
  const tools = new Map();
  const message = value => {
    if (value.role === 'assistant') {
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
          const questions = [...tools.values()].flatMap(tool => Array.isArray(tool.args?.questions) ? tool.args.questions : []);
          const title = clean(event.title);
          const heading = questions.some(question => clean(question.prompt) === title) ? undefined : title;
          pendingQuestion = clean([heading, ...questions.map(question => [question.prompt, ...(question.options ?? []).map(option => option.label)].filter(Boolean).join(' | '))].filter(Boolean).join(' | ')) || 'Answer the open Pi dialog.';
          break;
        }
        case 'ui_prompt_end': pendingQuestion = undefined; break;
        case 'agent_settled': tools.clear(); break;
      }
    },
    timeline() {
      const branch = ctx.sessionManager.getBranch();
      const results = new Map(branch.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult').map(entry => [entry.message.toolCallId, entry.message.isError]));
      const reversed = [];
      const omitted = { calls: 0, reasoning: 0 };
      let calls = 0, reasoning = 0, foundReply = false;
      for (let i = branch.length - 1; i >= 0 && !foundReply; i--) {
        const entry = branch[i];
        if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
        const parts = entry.message.content ?? [];
        for (let j = parts.length - 1; j >= 0; j--) {
          const part = parts[j], at = entry.timestamp;
          if (part.type === 'text') {
            reversed.push({ kind: 'reply', at, text: clip(part.text, 12000) });
            foundReply = true;
            break;
          }
          if (part.type === 'thinking') {
            if (++reasoning <= 3) reversed.push({ kind: 'reasoning', at, text: clip(part.thinking, 600) });
            else omitted.reasoning++;
          } else if (part.type === 'toolCall') {
            if (++calls <= 5) reversed.push({ kind: 'call', at, tool: clip(part.name, 160), summary: callSummary(part.name, part.arguments), state: tools.has(part.id) ? 'running' : results.get(part.id) ? 'failed' : 'done' });
            else omitted.calls++;
          }
        }
      }
      return boundTimeline({ busy: !ctx.isIdle(), failed, ...(pendingQuestion ? { pendingQuestion: clip(pendingQuestion, 4000) } : {}), ...(lastError ? { lastError: clip(lastError, 4000) } : {}), omitted, events: reversed.reverse() });
    },
    history(params = {}) {
      const { query, caseSensitive, before, limit } = validateHistoryParams(params);
      const all = [...branchItems(ctx.sessionManager.getBranch())];
      const eligible = before === undefined ? all : all.filter(item => item.index < before);
      let selected, key;
      if (query === undefined) {
        key = 'items';
        selected = eligible.slice(-limit).map(item => ({ ...item, text: clip(item.text, 4000) }));
      } else {
        key = 'matches';
        selected = [];
        // Match on the original string: Unicode lowercasing can change its length.
        const needle = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), caseSensitive ? 'u' : 'iu');
        for (let i = eligible.length - 1; i >= 0 && selected.length < limit; i--) {
          const item = eligible[i];
          const position = needle.exec(item.text)?.index ?? -1;
          if (position < 0) continue;
          selected.push({ ...item, text: item.text.slice(Math.max(0, position - 200), position + query.length + 200).toWellFormed() });
        }
      }
      const value = { [key]: selected };
      // Keep the requested page and its indexes even for heavily escaped text.
      while (Buffer.byteLength(JSON.stringify(value)) > 120 * 1024) {
        const longest = selected.reduce((a, b) => a.text.length > b.text.length ? a : b);
        longest.text = clip(longest.text, Math.floor(longest.text.length * 0.75));
      }
      return value;
    },
  };
}
