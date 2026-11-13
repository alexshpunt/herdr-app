// Opt-in deterministic provider for manual tests against a real Herdr App/core.
// Copy into the isolated test project's .pi/extensions directory, never user settings.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { appendFileSync } from 'node:fs';

export default function fixture(pi: ExtensionAPI) {
  const ids = ['controller', 'success', 'primary-error', 'fallback-error', 'late-error', 'slow'];
  pi.on('before_agent_start', async () => {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...pi.getAllTools().filter(tool => tool.name.startsWith('herdr_agent_')).map(tool => tool.name)])]);
  });
  pi.registerProvider('herdr-fixture', {
    name: 'Herdr live verification fixture', baseUrl: 'http://herdr-fixture.invalid', apiKey: 'fixture', api: 'openai-completions',
    models: ids.map(id => ({ id, name: `Herdr fixture: ${id}`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const output: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
      const last = context.messages.at(-1);
      const successful = context.messages.some(message => message.role === 'assistant' && message.stopReason !== 'error' && message.stopReason !== 'aborted');
      const text = (message: any) => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
      if (process.env.HERDR_FIXTURE_LOG) appendFileSync(process.env.HERDR_FIXTURE_LOG, `${JSON.stringify({ pid: process.pid, model: model.id, context })}\n`);
      void (async () => {
        if (model.id === 'slow') await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 30000);
          options?.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        const fail = model.id.endsWith('-error') && (model.id !== 'late-error' || successful);
        if (options?.signal?.aborted || fail) {
          output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
          output.errorMessage = options?.signal?.aborted ? 'Fixture aborted' : 'Intentional fixture model failure (not a network error)';
          stream.push({ type: 'error', reason: output.stopReason, error: output });
        } else if (model.id === 'controller' && last?.role === 'user') {
          const request = JSON.parse(text(last));
          output.content = [{ type: 'toolCall', id: `fixture-${Date.now()}`, name: request.name, arguments: request.arguments }];
          output.stopReason = 'toolUse';
          stream.push({ type: 'done', reason: 'toolUse', message: output });
        } else {
          output.content = [{ type: 'text', text: model.id === 'controller' ? `Fixture tool completed: ${text(last)}` : `Fixture ready: ${model.id}; ${text(last)}` }];
          stream.push({ type: 'done', reason: 'stop', message: output });
        }
        stream.end();
      })().catch(error => { output.stopReason = 'error'; output.errorMessage = String(error); stream.push({ type: 'error', reason: 'error', error: output }); stream.end(); });
      return stream;
    },
  });
}
