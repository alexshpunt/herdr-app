import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema, type Static } from 'typebox';
import { Text } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importFresh } from './client.mjs';

export default function herdrOrchestration(pi: ExtensionAPI): void {
  let client: InstanceType<typeof import('./client.mjs').AppClient> | undefined;
  let service: InstanceType<typeof import('./orchestration.mjs').Orchestrator> | undefined;
  let ipc: Awaited<ReturnType<typeof import('./ipc.mjs').startAgentIpc>> | undefined;
  let startup: 'pending' | 'started' | 'failed' = 'pending';
  let error: string | undefined;
  let ownerSession: string | undefined;
  let publishing = Promise.resolve();
  let lastPublication = '';
  const report = (ctx: ExtensionContext, value: unknown) => ctx.ui.notify(`Herdr agents: ${value instanceof Error ? value.message : String(value)}`, 'warning');
  const publish = (ctx: ExtensionContext) => {
    publishing = publishing.catch(() => {}).then(async () => {
      if (!client) return;
      const available = ctx.scopedModels.length ? ctx.scopedModels.map(item => item.model) : ctx.modelRegistry.getAvailable();
      const models = [...new Map(available.map(model => [`${model.provider}/${model.id}`, { id: `${model.provider}/${model.id}`, name: model.name }])).values()];
      const hc = process.env.HC_BIN || (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, process.platform === 'win32' ? 'hc.exe' : 'hc')).find(file => existsSync(file)) || 'hc';
      const route = ipc ? { socket: ipc.socket, token: ipc.token, node: process.execPath, request: fileURLToPath(new URL('./request.mjs', import.meta.url)), hc } : {};
      const label = { version: 1, pid: process.pid, session: ctx.sessionManager.getSessionId(), models, startup, ...route, ...(error ? { error } : {}) };
      const serialized = JSON.stringify(label);
      if (serialized === lastPublication) return;
      await client.publish(label);
      lastPublication = serialized;
    });
    return publishing;
  };
  const initialize = async (ctx: ExtensionContext) => {
    await publishing.catch(() => {});
    await ipc?.stop(); ipc = undefined;
    client = undefined; service = undefined; lastPublication = '';
    if (!process.env.HC_TERMINAL_ID || !process.env.HC_TERMINAL_SOCKET) return;
    const session = ctx.sessionManager.getSessionId();
    if (session !== ownerSession) { startup = 'pending'; error = undefined; ownerSession = session; }
    const suffix = randomUUID();
    const clientUrl = new URL('./client.mjs', import.meta.url); clientUrl.searchParams.set('load', suffix);
    const serviceUrl = new URL('./orchestration.mjs', import.meta.url); serviceUrl.searchParams.set('load', suffix);
    const [{ AppClient }, { Orchestrator, bindOrigin }] = await Promise.all([importFresh(clientUrl.href), importFresh(serviceUrl.href)]);
    client = new AppClient(bindOrigin, process.pid, session);
    const owner = await client!.owner();
    // /reload must never reopen the fallback window of an already-started agent.
    try {
      const previous = JSON.parse(owner.labels?.['herdr.pi'] ?? '{}');
      if (previous.pid === process.pid && previous.session === session && previous.startup === 'started') startup = 'started';
    } catch { /* An unrelated/malformed label cannot establish successful startup. */ }
    if (owner.foreground?.pid === process.pid) {
      const ipcUrl = new URL('./ipc.mjs', import.meta.url); ipcUrl.searchParams.set('load', suffix);
      const { startAgentIpc } = await importFresh(ipcUrl.href) as typeof import('./ipc.mjs');
      const currentClient = client;
      ipc = await startAgentIpc({ pid: process.pid, session,
        validate: async () => {
          const current = await currentClient!.owner();
          if (ownerSession !== session || ctx.sessionManager.getSessionId() !== session) throw new Error('The Pi session changed; inspect the agent again');
          if (startup !== 'started') throw new Error('The Pi agent has not completed startup');
          const status = typeof current.status === 'object' ? current.status : current.report;
          if (current.status === 'blocked' || status?.state === 'blocked') throw new Error('The agent is waiting for the user; do not bypass its question');
        },
        submit: (message: string) => pi.sendUserMessage(message, { deliverAs: 'followUp' }),
        report: (value: unknown) => report(ctx, value),
      });
    }
    service = new Orchestrator(client, path.join(getAgentDir(), 'herdr-orchestration', 'requests'));
    await publish(ctx);
  };
  pi.on('session_start', async (_event, ctx) => { try { await initialize(ctx); } catch (value) { report(ctx, value); } });
  pi.on('model_select', async (_event, ctx) => { try { await publish(ctx); } catch (value) { report(ctx, value); } });
  pi.on('before_agent_start', async (event, ctx) => {
    if (!process.env.HC_TERMINAL_ID || !process.env.HC_TERMINAL_SOCKET) return;
    try {
      if (!client || !service) await initialize(ctx);
      const origin = await client!.context();
      await publish(ctx);
      event.systemPromptOptions.sections.herdr = `${JSON.stringify(origin)}\nUse Herdr's deferred agent tools only to manage the user's independent agents and tasks. Start agents only at the user's explicit request or for an accepted process-findings task. Use replicate for your own parallel subtasks; do not supervise or remove the user's agents as your helpers.`;
    } catch (value) {
      event.systemPromptOptions.sections.herdr = `Pi PID ${process.pid}; Herdr placement is unavailable. Discover the Herdr agent tools only when the user asks to manage agents; inspect and resolve their context error before changing anything.`;
    }
  });
  pi.on('message_end', async (event, ctx) => {
    if (event.message.role !== 'assistant' || !client) return;
    const message = event.message;
    if (message.stopReason === 'error') { if (startup !== 'started') error = message.errorMessage ?? 'The first model response failed'; return; }
    if (message.stopReason === 'aborted') return;
    startup = 'started'; error = undefined;
    try { await publish(ctx); } catch (value) { report(ctx, value); }
  });
  pi.on('agent_settled', async (event, ctx) => {
    if (!client || startup === 'started' || event.aborted || !error) return;
    startup = 'failed';
    try { await publish(ctx); } catch (value) { report(ctx, value); }
  });
  // Keep the last label after exit: the app rejects its stale PID for catalogs and
  // mutations, while the startup observer can distinguish success from early exit.
  pi.on('session_shutdown', async () => { await publishing.catch(() => {}); await ipc?.stop(); ipc = undefined; client = undefined; service = undefined; });

  const namespace = { name: 'Herdr', description: 'Manage the user’s independent agents in Herdr App', instructions: 'Start agents only for tasks the user explicitly asked to run independently. Use replicate for your own subtasks. Keep user-owned agents running after your task ends.' };
  const target = {
    terminal: Type.String({ description: 'Machine-qualified terminal ID returned by list or inspect.' }),
    pid: Type.Integer({ minimum: 1, description: 'Current Pi PID returned by inspect; reject replaced processes.' }),
    session: Type.String({ minLength: 1, description: 'Current Pi session returned by inspect.' }),
  };
  const outputSchema = Type.Object({}, { additionalProperties: true });
  function register<T extends TSchema>(name: string, description: string, parameters: T, mutate: boolean, execute: (args: Static<T>, signal?: AbortSignal, update?: (data: unknown) => void) => Promise<unknown>) {
    pi.registerTool({
      name, label: name.replaceAll('_', ' '), description, parameters, outputSchema,
      exposure: 'deferred', namespace, executionMode: mutate ? 'sequential' : 'parallel',
      renderCall(args, theme) {
        const identity = (args as Record<string, unknown>).name ?? (args as Record<string, unknown>).terminal ?? '';
        return new Text(theme.fg('toolTitle', `${name.replace('herdr_agent_', 'Herdr ')}${identity ? ` · ${stripVTControlCharacters(String(identity))}` : ''}`), 0, 0);
      },
      renderResult(result, options, theme, context) {
        if (context.isError && !result.details) return new Text(theme.fg('error', result.content.filter(item => item.type === 'text').map(item => stripVTControlCharacters(item.text)).join('\n')), 0, 0);
        const data = (result.details ?? {}) as Record<string, any>;
        const clean = (value: unknown) => stripVTControlCharacters(String(value ?? ''));
        let lines: string[];
        if (Array.isArray(data.agents)) {
          const agents = options.expanded ? data.agents : data.agents.slice(0, 8);
          lines = [`${data.agents.length} Pi agent${data.agents.length === 1 ? '' : 's'}`, ...agents.map((agent: Record<string, unknown>) => `${clean(agent.name || agent.terminal)} · ${clean(agent.terminal)} · ${clean(agent.status || agent.state)}`)];
          if (agents.length < data.agents.length) lines.push('Expand to show the remaining agents.');
        } else {
          lines = [clean(data.outcome ?? data.status ?? data.state ?? 'Applied') + (data.model ? ` · ${clean(data.model)}` : '')];
          if (data.terminal) lines.push(clean(data.terminal));
          if (data.detail || data.message || data.error) lines.push(clean(data.detail ?? data.error ?? data.message));
          if (data.retainedPrimary?.terminal) lines.push(`Primary retained: ${clean(data.retainedPrimary.terminal)}`);
          if (options.expanded) {
            if (data.pid) lines.push(`Pi PID ${clean(data.pid)} · session ${clean(data.session)}`);
            if (data.space) lines.push(`Space ${clean(data.space)}`);
            if (data.screen) lines.push(clean(data.screen));
          }
        }
        return new Text(theme.fg(context.isError ? 'error' : 'toolOutput', lines.join('\n')), 0, 0);
      },
      annotations: { readOnlyHint: !mutate, destructiveHint: name.endsWith('_remove') || name.endsWith('_stop'), openWorldHint: true, idempotentHint: !mutate || name.endsWith('_create') },
      async execute(_call, args, signal, onUpdate) {
        if (!client || !service) throw new Error('Herdr agent context is unavailable. Run this Pi as the foreground process of a Herdr App terminal and reload Pi.');
        const data = await execute(args, signal, value => onUpdate?.({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value }));
        const outcome = data && typeof data === 'object' && 'outcome' in data ? data.outcome : undefined;
        const isError = ['unknown', 'model-failed', 'exited', 'still_working', 'unconfirmed'].includes(String(outcome));
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)), isError };
      },
    });
  }
  register('herdr_agent_list', 'Use herdr_agent_list to find the user’s Pi agents, their stable Herdr identities and configured workflow profiles.', Type.Object({
    space: Type.Optional(Type.String({ description: 'Exact space ID. Omit to list agents across spaces.' })),
    machine: Type.Optional(Type.String({ description: 'Configured Herdr machine. Omit to list across machines.' })),
  }), false, async args => { await client!.context(); return client!.list(args); });
  register('herdr_agent_inspect', 'Use herdr_agent_inspect to read one agent’s state, current PID and session, startup outcome and screen before acting on it.', Type.Object({
    terminal: target.terminal, lines: Type.Optional(Type.Integer({ minimum: 0, maximum: 400, default: 40, description: 'Lines of history above the screen.' })),
  }), false, async args => { await client!.context(); return client!.inspect(args.terminal, args.lines); });
  register('herdr_agent_create', 'Use herdr_agent_create to start an independent task for the user in a visible Herdr tab. Use replicate for your own subtasks. The first message is submitted at launch; fallback is limited to startup before the first successful assistant response.', Type.Object({
    requestId: Type.String({ minLength: 1, description: 'Stable unique task key, such as its issue ID. Reuse the same key and inputs after interruption; do not choose a new key to retry an unknown launch.' }),
    name: Type.String({ minLength: 1, description: 'Visible agent tab name.' }),
    message: Type.String({ minLength: 1, description: 'First task message, including its accepted task link.' }),
    folder: Type.String({ minLength: 1, description: 'Absolute repository folder on the target machine.' }),
    profile: Type.String({ minLength: 1, description: 'Workflow profile ID from Herdr settings: feature or bug.' }),
    space: Type.Optional(Type.String({ description: 'Existing exact space ID. Omit to use this Pi’s space unless newSpace is supplied.' })),
    newSpace: Type.Optional(Type.Object({ name: Type.String({ minLength: 1 }), machine: Type.Optional(Type.String({ description: 'Configured machine; default this Pi’s machine. Empty string selects the app’s local machine.' })) })),
    model: Type.Optional(Type.String({ minLength: 1, description: 'Explicit provider/model override. Default the profile’s primary model.' })),
    fallbackModel: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: 'Startup-only provider/model override. Null disables fallback; omitted uses the profile.' })),
    thinking: Type.Optional(Type.Union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map(value => Type.Literal(value)), { description: 'Thinking override. Default the profile’s level.' })),
  }), true, (args, signal, update) => service!.create(args, signal, update));
  register('herdr_agent_send', 'Use herdr_agent_send to submit a follow-up message to an agent the user asked you to contact. Read its current identity first; do not bypass a blocked user question.', Type.Object({ ...target, message: Type.String({ minLength: 1 }) }), true, args => service!.act('send', args));
  register('herdr_agent_stop', 'Use herdr_agent_stop to interrupt an agent at the user’s request without closing its tab or killing its terminal.', Type.Object(target), true, args => service!.act('stop', args));
  register('herdr_agent_remove', 'Use herdr_agent_remove to close a dedicated agent tab and end its terminal at the user’s request. Keep the user’s other agents and panes intact.', Type.Object(target), true, args => service!.act('remove', args));
}
