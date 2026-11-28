import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema, type Static } from 'typebox';
import { Text } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importFresh } from './client.mjs';
import { childDepth } from './orchestration.mjs';

/** Commands pi-agent-herdr may send through the bridge. Launches go only through replicate and subagent. */
const BRIDGE_COMMANDS = ['agent.list', 'agent.inspect', 'agent.history', 'agent.send', 'agent.remove', 'agent.replicate', 'agent.subagent', 'workflow.get'];
type Client = InstanceType<typeof import('./client.mjs').AppClient>;
type Service = InstanceType<typeof import('./orchestration.mjs').Orchestrator>;

/** A sub-agent is a workflow-profile launch, with startup fallback, as a tab of the caller's own space. */
async function startSubagent(client: Client, service: Service | undefined, args: Record<string, unknown>, depth: number) {
  if (!service) throw new Error('agent.subagent is unavailable until this Pi finishes connecting to Herdr; retry shortly');
  for (const key of ['requestId', 'name', 'folder', 'profile', 'task'])
    if (typeof args[key] !== 'string' || !(args[key] as string).trim()) throw new Error(`agent.subagent needs a non-empty ${key}`);
  const origin = await client.context();
  const input = { requestId: args.requestId as string, name: args.name as string, folder: args.folder as string, profile: args.profile as string, message: args.task as string };
  try { return await service.create(input, undefined, undefined, { space: origin.space, depth }); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const fields = error && typeof error === 'object' ? error as { code?: string; effect?: string; requestId?: string } : {};
    throw Object.assign(new Error(`agent.subagent refused: ${reason}`), fields);
  }
}

export default function herdrOrchestration(pi: ExtensionAPI): void {
  // Pi exits on a long option no extension registered. Herdr's launch flags stay known even
  // while Workflow is turned off, so a replica or agent started just before still runs.
  pi.registerFlag('herdr-workflow-model', { type: 'string', description: 'Exact model requested by a Herdr workflow launch' });
  pi.registerFlag('herdr-workflow-thinking', { type: 'string', description: 'Exact thinking level requested by a Herdr workflow launch' });
  pi.registerFlag('herdr-depth', { type: 'string', description: 'Nesting depth of a Herdr replica or sub-agent; set by the launch' });
  // After a reboot or a lost holder, the core reopens this session in the terminal
  // instead of a bare shell. This works whether or not Workflow is turned on.
  let resume: ReturnType<typeof import('./resume.mjs').createResume> | undefined;
  let resumeWarned = false;
  const followSession = async (ctx: ExtensionContext) => {
    // A print-mode run (`pi -p`) ends by itself: there is no conversation to reopen.
    if (!process.env.HC_TERMINAL_ID || !process.env.HC_TERMINAL_SOCKET || !ctx.hasUI) return;
    try {
      if (!resume) {
        const url = new URL('./resume.mjs', import.meta.url); url.searchParams.set('load', randomUUID());
        const { createResume } = await importFresh(url.href) as typeof import('./resume.mjs');
        resume = createResume();
      }
      const flags = Object.fromEntries(['herdr-workflow-model', 'herdr-workflow-thinking', 'herdr-depth'].map(name => [name, pi.getFlag(name)]));
      await resume.update({ sessionFile: ctx.sessionManager.getSessionFile(), flags });
    } catch (value) {
      if (resumeWarned) return;
      resumeWarned = true;
      ctx.ui.notify(`Herdr agents: this session will not reopen by itself after a reboot: ${value instanceof Error ? value.message : String(value)}`, 'warning');
    }
  };
  // Not awaited: a slow core must not hold up Pi's start or the end of a turn.
  pi.on('session_start', async (_event, ctx) => { void followSession(ctx); });
  // A Pi started from a shell becomes the terminal's foreground a moment after it starts.
  pi.on('agent_end', async (_event, ctx) => { void followSession(ctx); });
  pi.on('session_shutdown', async event => { try { await resume?.shutdown(event.reason); } catch { /* The next loss then reopens it once. */ } });
  // Read on every reload, not through a cached helper module.
  try {
    const features = JSON.parse(readFileSync(path.join(getAgentDir(), 'herdr-features.json'), 'utf8'));
    if (features.version !== 1 || features.workflow !== true) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  // Agents the user starts are depth 0; their replicas and sub-agents 1; theirs 2, which start no more.
  const depth = () => { const value = Number(pi.getFlag('herdr-depth') ?? 0); return Number.isSafeInteger(value) && value > 0 ? value : 0; };
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
    const current = client, orchestrator = service;
    const invoke = (name: string, args: Record<string, unknown>) => {
      if (!BRIDGE_COMMANDS.includes(name)) throw new Error('Unsupported Herdr bridge command');
      if (client !== current) throw new Error('Herdr bridge changed; reload or retry the read');
      if (name !== 'agent.replicate' && name !== 'agent.subagent') return current.command(name, args);
      const child = childDepth(name, depth());
      if (name === 'agent.replicate') return current.replicate({ ...args, depth: child });
      return startSubagent(current, orchestrator, args, child);
    };
    const ensureCurrent = () => { if (client !== current) throw new Error('Herdr bridge changed; reacquire it for the current session'); };
    provide({ version: 1, command: invoke,
      commandTracked(name: string, args: Record<string, unknown>, options: { toolCallId?: string | null } = {}) {
        ensureCurrent();
        if (options.toolCallId != null && (typeof options.toolCallId !== 'string' || !options.toolCallId)) throw new Error('Invalid tool call ID');
        return current.tracked(name, options.toolCallId, () => invoke(name, args));
      },
      recovery: {
        list() { ensureCurrent(); return current.recoveryList(); },
        ack(input: { items: { id: string; revision: string }[] }) { ensureCurrent(); return current.recoveryAck(input); },
      },
    });
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
    const candidate = new AppClient(bindOrigin, process.pid, session, { recoveryRoot: path.join(getAgentDir(), 'herdr-orchestration', 'recovery') });
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
      event.systemPromptOptions.sections.herdr = `${JSON.stringify(origin)}\nYour replicas and sub-agents are yours to steer and close. Agents started with the Herdr agent tool belong to the user: do not supervise, message or close them as your helpers unless the user asks.`;
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

  const namespace = { name: 'Herdr', description: 'Start and wait for the user’s independent agents in Herdr App', instructions: 'Start independent agents for the user only at the user’s request or as the orchestrator of a series of tasks the user gave you. For your own work use replicate or subagent. Keep user-owned agents running after your task ends.' };
  const outputSchema = Type.Object({}, { additionalProperties: true });
  function register<T extends TSchema>(name: string, description: string, promptGuidelines: string[], parameters: T, execute: (args: Static<T>, signal?: AbortSignal, update?: (data: unknown) => void) => Promise<unknown>) {
    pi.registerTool({
      name, label: name === 'agent' ? 'Herdr agent' : name.replaceAll('_', ' '), description, promptGuidelines, parameters, outputSchema,
      exposure: 'deferred', namespace, executionMode: 'sequential',
      renderCall(args, theme) {
        const identity = (args as Record<string, unknown>).name ?? (args as Record<string, unknown>).terminal ?? '';
        return new Text(theme.fg('toolTitle', `${name === 'agent' ? 'Herdr agent' : name}${identity ? ` · ${stripVTControlCharacters(String(identity))}` : ''}`), 0, 0);
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
  register('agent', 'Use agent to start an independent agent for the user in a new Herdr space of its own: a task the user asked to run on its own, or the next task of a series the user made you orchestrate. The user owns it. The first message is submitted at launch; a profile\'s fallback model is used only when startup fails before the first successful response.', [
    'Use agent only at the user\'s request or as the orchestrator of a series of tasks the user gave you. For a part of your own task use replicate; for a side track of your own work use subagent.',
    'Read herdr:profiles before choosing a profile, and choose the one whose description fits the task, or the one the user names. Use an explicit model override only when the user names a model.',
    'Use the task\'s issue ID as requestId and give the accepted task link in message. After an interruption, reuse the same requestId and inputs; never retry an unconfirmed launch under a new key.',
    'Tell the user where each agent is and report a launch that did not start, with its reason. Do not supervise, message or close the user\'s agents unless the user asks.',
    'As the orchestrator of a series, wait with wait_for_agents for the agents whose results you need next, with background: true while you have other work. Answer what the task and the user\'s decisions already settle, bring real forks to the user, and start the next tasks as they unblock.',
  ], Type.Object({
    requestId: Type.String({ minLength: 1, description: 'Stable unique task key, such as its issue ID. Reuse the same key and inputs after interruption; do not choose a new key to retry an unknown launch.' }),
    name: Type.String({ minLength: 1, description: 'Visible agent name; it also names the agent’s new space and tab.' }),
    message: Type.String({ minLength: 1, description: 'First task message, including its accepted task link.' }),
    folder: Type.String({ minLength: 1, description: 'Absolute repository folder on the target machine.' }),
    profile: Type.String({ minLength: 1, description: 'Workflow profile ID; read herdr:profiles for the current profiles and what each is for.' }),
    machine: Type.Optional(Type.String({ description: 'Configured machine for the agent’s new space; default this Pi’s machine. Empty string selects the app’s local machine.' })),
    model: Type.Optional(Type.String({ minLength: 1, description: 'Explicit provider/model override. Default the profile’s primary model.' })),
    fallbackModel: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: 'Startup-only provider/model override. Null disables fallback; omitted uses the profile.' })),
    thinking: Type.Optional(Type.Union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map(value => Type.Literal(value)), { description: 'Thinking override. Default the profile’s level.' })),
  }), (args, signal, update) => service!.create(args, signal, update));

}
