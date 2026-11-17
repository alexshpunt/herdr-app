import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema, type Static } from 'typebox';
import { Text } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importFresh } from './client.mjs';

export default function herdrOrchestration(pi: ExtensionAPI): void {
  // Read on every reload, not through a cached helper module.
  try {
    const features = JSON.parse(readFileSync(path.join(getAgentDir(), 'herdr-features.json'), 'utf8'));
    if (features.version !== 1 || features.workflow !== true) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  pi.registerFlag('herdr-workflow-model', { type: 'string', description: 'Exact model requested by a Herdr workflow launch' });
  pi.registerFlag('herdr-workflow-thinking', { type: 'string', description: 'Exact thinking level requested by a Herdr workflow launch' });
  let selectionError: ((ctx: ExtensionContext) => string | undefined) | undefined;
  let client: InstanceType<typeof import('./client.mjs').AppClient> | undefined;
  let service: InstanceType<typeof import('./orchestration.mjs').Orchestrator> | undefined;
  let ipc: Awaited<ReturnType<typeof import('./ipc.mjs').startAgentIpc>> | undefined;
  let inspection: ReturnType<typeof import('./inspect.mjs').createInspection> | undefined;
  let startup: 'pending' | 'started' | 'failed' = 'pending';
  let error: string | undefined;
  let ownerSession: string | undefined;
  let publishing = Promise.resolve();
  let lastPublication = '';
  pi.events.on('herdr:bridge', (request: unknown) => {
    if (!client || !request || typeof request !== 'object') return;
    const provide = (request as { provide?: unknown }).provide;
    if (typeof provide !== 'function') return;
    const current = client;
    provide({ version: 1, command(name: string, args: Record<string, unknown>) {
      if (!['agent.list', 'agent.inspect', 'agent.history', 'agent.send', 'agent.remove'].includes(name)) throw new Error('Unsupported Herdr bridge command');
      if (client !== current) throw new Error('Herdr bridge changed; reload or retry the read');
      return current.command(name, args);
    } });
  });
  const report = (ctx: ExtensionContext, value: unknown) => ctx.ui.notify(`Herdr agents: ${value instanceof Error ? value.message : String(value)}`, 'warning');
  const publish = (ctx: ExtensionContext) => {
    publishing = publishing.catch(() => {}).then(async () => {
      if (!client) return;
      const available = ctx.scopedModels.length ? ctx.scopedModels.map(item => item.model) : ctx.modelRegistry.getAvailable();
      const models = [...new Map(available.map(model => [`${model.provider}/${model.id}`, { id: `${model.provider}/${model.id}`, name: model.name }])).values()];
      const hc = client.hc;
      const route = ipc ? { inspect: 1, socket: ipc.socket, token: ipc.token, node: process.execPath, request: fileURLToPath(new URL('./request.mjs', import.meta.url)), hc } : {};
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
    client = undefined; service = undefined; inspection = undefined; selectionError = undefined; lastPublication = '';
    if (!process.env.HC_TERMINAL_ID || !process.env.HC_TERMINAL_SOCKET) return;
    const session = ctx.sessionManager.getSessionId();
    if (session !== ownerSession) { startup = 'pending'; error = undefined; ownerSession = session; }
    const suffix = randomUUID();
    const clientUrl = new URL('./client.mjs', import.meta.url); clientUrl.searchParams.set('load', suffix);
    const serviceUrl = new URL('./orchestration.mjs', import.meta.url); serviceUrl.searchParams.set('load', suffix);
    const [{ AppClient, ownsTerminal, workflowSelectionError }, { Orchestrator, bindOrigin }] = await Promise.all([importFresh(clientUrl.href), importFresh(serviceUrl.href)]);
    const candidate = new AppClient(bindOrigin, process.pid, session);
    const owner = await candidate.terminal();
    // A nested Pi, such as a replicate copy behind a wrapper shell, does not own
    // the terminal it inherited. It stays inactive instead of warning on every publication.
    if (!ownsTerminal(owner, process.pid)) return;
    client = candidate;
    selectionError = ctx => workflowSelectionError(pi.getFlag('herdr-workflow-model'), pi.getFlag('herdr-workflow-thinking'), ctx.model, pi.getThinkingLevel());
    // /reload must never reopen the fallback window of an already-started agent.
    // Session history also proves success when publishing the label was interrupted.
    if (ctx.sessionManager.getBranch().some(entry => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.stopReason !== 'error' && entry.message.stopReason !== 'aborted')) startup = 'started';
    try {
      const previous = JSON.parse(owner.labels?.['herdr.pi'] ?? '{}');
      if (previous.pid === process.pid && previous.session === session && previous.startup === 'started') startup = 'started';
    } catch { /* An unrelated/malformed label cannot establish successful startup. */ }
    const ipcUrl = new URL('./ipc.mjs', import.meta.url); ipcUrl.searchParams.set('load', suffix);
    const { startAgentIpc } = await importFresh(ipcUrl.href) as typeof import('./ipc.mjs');
    const currentClient = candidate;
    const inspectUrl = new URL('./inspect.mjs', import.meta.url); inspectUrl.searchParams.set('load', suffix);
    const { createInspection } = await importFresh(inspectUrl.href) as typeof import('./inspect.mjs');
    inspection = createInspection(ctx);
    const currentSession = () => {
      if (ownerSession !== session || ctx.sessionManager.getSessionId() !== session) throw new Error('The Pi session changed; inspect the agent again');
    };
    ipc = await startAgentIpc({ pid: process.pid, session,
      validate: async () => {
        const current = await currentClient.owner();
        if (ownerSession !== session || ctx.sessionManager.getSessionId() !== session) throw new Error('The Pi session changed; inspect the agent again');
        if (startup !== 'started') throw new Error('The Pi agent has not completed startup');
        const status = typeof current.status === 'object' ? current.status : current.report;
        if (inspection?.timeline().pendingQuestion || current.status === 'blocked' || status?.state === 'blocked') throw new Error('The agent is waiting for the user; do not bypass its question');
      },
      inspect: async () => {
        await currentClient.owner(); currentSession();
        return inspection!.timeline();
      },
      history: async (params: Parameters<NonNullable<typeof inspection>['history']>[0]) => {
        await currentClient.owner(); currentSession();
        return inspection!.history(params);
      },
      submit: (message: string) => pi.sendUserMessage(message, { deliverAs: 'steer' }),
      report: (value: unknown) => report(ctx, value),
    });
    service = new Orchestrator(client, path.join(getAgentDir(), 'herdr-orchestration', 'requests'));
    if (startup !== 'started' && selectionError(ctx)) {
      startup = 'failed'; error = selectionError(ctx);
      ctx.ui.notify(error!, 'error');
    }
    await publish(ctx);
  };
  pi.on('session_start', async (_event, ctx) => { try { await initialize(ctx); } catch (value) { report(ctx, value); } });
  pi.on('before_agent_start', async event => { inspection?.event(event); });
  pi.on('message_end', async event => { inspection?.event(event); });
  pi.on('tool_execution_start', async event => { inspection?.event(event); });
  pi.on('tool_execution_end', async event => { inspection?.event(event); });
  pi.on('ui_prompt_start', async event => { inspection?.event(event); });
  pi.on('ui_prompt_end', async event => { inspection?.event(event); });
  pi.on('agent_settled', async event => { inspection?.event(event); });
  const restoreInspection = async (_event: unknown, ctx: ExtensionContext) => {
    if (!inspection) return;
    const url = new URL('./inspect.mjs', import.meta.url); url.searchParams.set('load', randomUUID());
    const { createInspection } = await importFresh(url.href) as typeof import('./inspect.mjs');
    inspection = createInspection(ctx);
  };
  pi.on('session_tree', restoreInspection);
  pi.on('session_compact', restoreInspection);
  pi.on('input', async (_event, ctx) => {
    if (startup === 'started' || !selectionError) return;
    const failure = selectionError(ctx);
    if (!failure) return;
    startup = 'failed'; error = failure;
    ctx.ui.notify(failure, 'error');
    try { await publish(ctx); } catch (value) { report(ctx, value); }
    return { action: 'handled' };
  });
  pi.on('model_select', async (_event, ctx) => { try { await publish(ctx); } catch (value) { report(ctx, value); } });
  pi.on('before_agent_start', async (event, ctx) => {
    if (!process.env.HC_TERMINAL_ID || !process.env.HC_TERMINAL_SOCKET) return;
    try {
      if (!client || !service) await initialize(ctx);
      // A nested Pi has no Herdr placement of its own and gets no Herdr prompt section.
      if (!client) return;
      const origin = await client.context();
      await publish(ctx);
      event.systemPromptOptions.sections.herdr = `${JSON.stringify(origin)}\nUse Herdr's deferred agent tools only to manage the user's independent agents and tasks. Start agents only at the user's explicit request or as the orchestrator of a series the user gave you. Use replicate for your own parallel subtasks; do not supervise or remove the user's agents as your helpers.`;
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
  const outputSchema = Type.Object({}, { additionalProperties: true });
  function register<T extends TSchema>(name: string, description: string, parameters: T, execute: (args: Static<T>, signal?: AbortSignal, update?: (data: unknown) => void) => Promise<unknown>) {
    pi.registerTool({
      name, label: name.replaceAll('_', ' '), description, parameters, outputSchema,
      exposure: 'deferred', namespace, executionMode: 'sequential',
      renderCall(args, theme) {
        const identity = (args as Record<string, unknown>).name ?? (args as Record<string, unknown>).terminal ?? '';
        return new Text(theme.fg('toolTitle', `${name.replace('herdr_agent_', 'Herdr ')}${identity ? ` · ${stripVTControlCharacters(String(identity))}` : ''}`), 0, 0);
      },
      renderResult(result, options, theme, context) {
        if (context.isError && (!result.details || typeof result.details !== 'object' || Object.keys(result.details).length === 0)) return new Text(theme.fg('error', result.content.filter(item => item.type === 'text').map(item => stripVTControlCharacters(item.text)).join('\n')), 0, 0);
        const data = (result.details ?? {}) as Record<string, any>;
        const clean = (value: unknown) => stripVTControlCharacters(String(value ?? ''));
        const lines = [clean(data.outcome ?? data.status ?? data.state ?? 'Applied') + (data.model ? ` · ${clean(data.model)}` : '')];
        if (data.terminal) lines.push(clean(data.terminal));
        if (data.detail || data.message || data.error || data.startupError) lines.push(clean(data.detail ?? data.error ?? data.startupError ?? data.message));
        if (data.retainedPrimary?.terminal) lines.push(`Primary retained: ${clean(data.retainedPrimary.terminal)}`);
        if (options.expanded) {
          if (data.pid) lines.push(`Pi PID ${clean(data.pid)} · session ${clean(data.session)}`);
          if (data.space) lines.push(`Space ${clean(data.space)}`);
        }
        return new Text(theme.fg(context.isError ? 'error' : 'toolOutput', lines.join('\n')), 0, 0);
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      async execute(_call, args, signal, onUpdate) {
        if (!client || !service) throw new Error('Herdr agent context is unavailable. Run this Pi as the foreground process of a Herdr App terminal and reload Pi.');
        const data = await execute(args, signal, value => onUpdate?.({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value }));
        const outcome = data && typeof data === 'object' && 'outcome' in data ? data.outcome : undefined;
        const isError = ['unknown', 'model-failed', 'exited', 'still_working', 'unconfirmed'].includes(String(outcome));
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)), isError };
      },
    });
  }
  register('herdr_agent_create', 'Use herdr_agent_create to start an independent task for the user in a new Herdr space of its own. Use replicate for your own subtasks. The first message is submitted at launch; fallback is limited to startup before the first successful assistant response.', Type.Object({
    requestId: Type.String({ minLength: 1, description: 'Stable unique task key, such as its issue ID. Reuse the same key and inputs after interruption; do not choose a new key to retry an unknown launch.' }),
    name: Type.String({ minLength: 1, description: 'Visible agent name; it also names the agent’s new space and tab.' }),
    message: Type.String({ minLength: 1, description: 'First task message, including its accepted task link.' }),
    folder: Type.String({ minLength: 1, description: 'Absolute repository folder on the target machine.' }),
    profile: Type.String({ minLength: 1, description: 'Workflow profile ID from Herdr settings: feature or bug.' }),
    machine: Type.Optional(Type.String({ description: 'Configured machine for the agent’s new space; default this Pi’s machine. Empty string selects the app’s local machine.' })),
    model: Type.Optional(Type.String({ minLength: 1, description: 'Explicit provider/model override. Default the profile’s primary model.' })),
    fallbackModel: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: 'Startup-only provider/model override. Null disables fallback; omitted uses the profile.' })),
    thinking: Type.Optional(Type.Union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map(value => Type.Literal(value)), { description: 'Thinking override. Default the profile’s level.' })),
  }), (args, signal, update) => service!.create(args, signal, update));

}
