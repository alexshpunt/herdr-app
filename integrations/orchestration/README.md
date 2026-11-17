# Herdr Pi orchestration

Settings → Integrations → Workflow controls registration and the panel. Off means no Herdr tools, deferred catalog entries, resource bridge or Herdr prompt section. Reload running Pi sessions after changing it; new sessions read the value immediately. The App writes `herdr-features.json` in each connected machine's Pi agent directory and synchronizes it again on reconnect. Missing files preserve the enabled default; invalid files disable the integration. Extensions stay installed, and re-enabling needs no reinstall.

Herdr App embeds this extension and installs it on each connected machine. Pi discovers it in the managed `extensions/herdr-orchestration` directory under its agent directory. Reload an already running Pi after an update. No runtime dependency installation is needed.

Herdr resolves the target machine's Pi npm entrypoint and starts it directly with Node. This preserves the first task's quotes and newlines and lets the core verify Pi's actual PID. An ordinary Pi exit remains finished; core keep-mode restores a shell only after program loss. A standalone binary or shell alias that cannot be resolved safely produces a launch error instead of guessing another command.

`herdr_agent_create` uses Pi's native deferred exposure in the `Herdr` namespace. Discover it through `tool_search` to start independent user-owned agents in visible App tabs. Use the `pi-agent-herdr` extension's `read`, `search` and `write` on `herdr:` resources to find, inspect and message them, and its deferred `wait_for_agents` in the same `Herdr` namespace to wait until they stop working. `delete` on `herdr:<terminal>` closes an agent the caller started for itself or one the user asked it to close; other agents stay with the user in the App's UI or CLI. Use `replicate` for the calling agent's own subtasks.

## Placement

Each agent that `herdr_agent_create` starts opens in a new space of its own, named after the agent, with one tab of the same name. The space is on the requested `machine`, else on the calling Pi's machine, and starts in the given folder. It does not take focus, so the caller's space and tab bar stay as they were. The tool has no way to put an agent into an existing space. A startup fallback opens as a second tab in its primary's space. Apps opened for the agent (Linear, GitHub, Files, Diff, reviews) open as tabs in its space. `agent.remove`, from the user or from `delete(herdr:<terminal>)`, closes the agent's tab; the space closes with its last tab.

## Identity and transport

Only the terminal's own Pi publishes `herdr.pi`. Its version-1 label contains `pid`, `session`, the available model catalog (`models` with `id` and `name`), and `startup`. The catalog uses the scoped picker models when present, otherwise the authenticated model registry. Refresh happens on session load, model selection and before a run.

The App accepts a catalog only while the terminal is live and the label PID matches the terminal's root Pi process or its verified foreground process. Root identity also works before the core's first foreground sample and while Pi runs a child tool. Agent mutations also require the inspected PID and session. The requesting Pi's prompt includes its PID and exact App terminal, machine and space IDs after verifying its placement. A nested Pi cannot claim an inherited terminal. Such a Pi, for example a `replicate` copy started behind a wrapper shell, stays inactive without warnings: it publishes no label, gets no Herdr prompt section, and its Herdr tools report that agent context is unavailable.

Local `hc` verifies and labels the requesting terminal. The App publishes a private `herdr.app` route before launch. Requests travel back to that originating App through a bounded, versioned core document and a small label trigger, not an executable on the Pi machine. This works over the App's existing local/SSH connections, including machines unknown to the calling Pi's core. Requests are claimed with compare-and-set before dispatch; accepted or uncertain mutations are never replayed. App restarts change the route epoch. Missing routes require updating the App and reloading Pi.

Messages use the target Pi's authenticated local socket and `pi.sendUserMessage(message, { deliverAs: 'steer' })`, reached through `machine.exec`. A working Pi receives them after its current tools and before its next model request; an idle Pi starts a turn immediately. They never type into terminal input: an exited or replaced Pi cannot turn a task message into a shell command. Socket credentials stay private in core labels and never enter tool results or the prompt.

## Inspection

Omit `screen` on `agent.inspect` to read a timeline from the active Pi session branch. It starts at the last assistant text part and includes subsequent reasoning and calls in time order. Up to five calls and three reasoning parts are retained; omitted counts are explicit. Calls report running, failed or done state, without results. A pending user question includes its options. Busy state and errors retain their lifecycle semantics. No model or Usage extension is involved.

Replies preserve newlines and both ends when cut (12,000 characters maximum). Reasoning is bounded to 600 characters, call summaries to 160, and the serialized timeline to 48 KB. The App verifies the same PID/session after reading. An unavailable or old Pi returns an error naming the reason; there is no automatic screen fallback.

`agent.history {terminal, query?, caseSensitive?, before?, limit?}` reads the whole active branch, including user messages and tool results. Each item has a stable zero-based index and timestamp. Paging returns up to 20 items by default, at most 50, before an exclusive index. Text is cut to 4,000 characters with a marker. Literal queries of at most 200 characters return newest matches first with context snippets; matching is case-insensitive unless requested otherwise. Responses stay within 120 KB.

Set `screen: true` for the unmodified terminal screen and optional history (`lines`: 0–400; command default 80). Set `screen: false` for identity/status metadata only. These explicit modes remain available to the CLI and startup observation.

## Resource bridge

The `pi-agent-herdr` IDE extension uses the synchronous `herdr:bridge` event. Its request supplies a `provide(api)` callback; an active integration provides `{version: 1, command(name, args)}` during emit. The bridge accepts only `agent.list`, `agent.inspect`, `agent.history`, `agent.send` and `agent.remove`, using the same authenticated AppClient and origin checks. The App refuses `agent.send` and `agent.remove` for the calling Pi's own terminal, and `agent.remove` for a tab with other panes. It provides nothing outside an owned Herdr terminal. Reload Pi after updating the integration.

Read `herdr:<terminal>` before writing to or deleting it. The resource extension keeps the observed identity privately and refuses writes after a replacement Pi, during startup, or while the recipient waits for the user. Use `herdr:<terminal>/history` for paging and literal search over the full branch. Repeated timeline reads omit an unchanged reply. See `docs:herdr` in Pi for resource addresses and read budgets.

Codemode timeline entries show the tool name; their scripts remain available in history. An open Pi dialog keeps a timeline in `waiting` even when the agent continues background work. Untitled dialogs show a reminder to answer in Pi.

## Workflow models

`workflow.models` reads the selected machine's installed Pi SDK and global `enabledModels` settings without starting Pi or loading its extensions. Scope patterns use Pi's resolver against its local model catalog, including `models.json` and models without credentials. With no scope configured, it lists the local catalog. A current live Pi can supplement it with extension-defined models. Project-specific scopes and providers loaded only by extensions need a live session or manual entry.

The App caches snapshots for 30 seconds and refreshes them off the UI thread. The reply includes `loading`, scope diagnostics and lookup errors. Looking up a catalog does not refresh credentials or fetch network model metadata. A catalog error leaves both pickers available: enter an exact `provider/model` in their search to select it. Every thinking level can be saved for any model; availability is checked at launch.

## Startup and receipts

Workflow launches pass `--herdr-workflow-model` and `--herdr-workflow-thinking` alongside Pi's normal model and thinking flags. The extension checks the actual selection before the first request. A substituted model or clamped thinking level publishes a startup failure and blocks that request. The startup fallback applies once, with the same requested thinking level. Launch receipts keep each attempt's model, thinking level, outcome and error, including the primary error after a successful fallback. An early Pi exit includes its retained terminal error.

A successful assistant response, including a tool call, permanently changes startup to `started`. Reload preserves that boundary. A first-response error changes startup to `failed` only after Pi settles, allowing Pi's own automatic retries first. Later model errors never reopen startup fallback.

Create saves a write-ahead receipt under the Pi agent directory's `herdr-orchestration/requests`. Reuse a task's stable `requestId` and identical inputs after interruption. A repeated request returns its saved receipt without launching again. Concurrent callers cannot claim the same receipt. An unconfirmed launch is `unknown`; inspect Herdr before taking further action. Do not change the request key to retry it.

Create observes startup for up to 90 seconds. Only a verified first-response failure or early exit permits one configured fallback attempt. A blocked, cancelled, disconnected or timed-out observation leaves the existing agent intact and reports its state. The primary is rechecked before fallback. A recovered primary is not replaced. A fallback joins a live primary's space; after an early exit it opens a new space because the primary's last tab may already have closed. A failed primary stays available for inspection rather than being removed automatically: the user may resume it while fallback starts. Leave removal to the user in the App's UI or CLI.

Workflow settings open from the toolbar button and dock beside the active-tab workspace, below the global App header. Their compact controls follow the Spaces sidebar style. Primary model, fallback model and thinking level save on selection, without a Refresh button or footer. `workflow.get` returns those persisted profiles. Create uses the selected profile unless explicit overrides are supplied.

## Checks

```sh
npm ci --prefix integrations/orchestration
npm run check --prefix integrations/orchestration
npm test --prefix integrations/orchestration
```

The suite covers request receipts, fallback boundaries and identity guards, plus real-Pi deferred registration, native tool error rendering and module refresh on reload. Run integration checks on the build worker. Verify the installed App and reloaded Pi when changing the runtime contract.

For installed-App verification without paid inference, copy `test/fixtures/live-provider.ts` into an isolated test project's `.pi/extensions/`. It registers `herdr-fixture/{controller,success,primary-error,fallback-error,late-error,slow}`. Use a separate `HERDR_APP_HOME`, `HC_SESSION` and `PI_CODING_AGENT_DIR`. Load `pi-agent-ide` and `pi-agent-herdr` for resource checks. The controller's first user message is JSON `{ "name": "read", "arguments": { "path": "herdr:" } }`; it calls the actual shared resource tool and prints its result. Never install the fixture in personal extension settings. Remove the test App, its own core holder and project after verification.

### Workflow UI regression check

In an isolated installed App, open Workflow for a machine with scoped models configured and no running Pi:

1. Use the toolbar button to open and close Workflow. Confirm the terminal workspace narrows beside the dock and regains its width on close. The global header, its actions and window controls keep their width above the dock; the dock aligns with the workspace's top and bottom.
2. Open a primary model picker. Confirm model names and IDs are visible, then scroll to the last choice. Its scrollbar stays visible while the list overflows.
3. Confirm every scoped model appears in both pickers. Search by name or ID, then enter an uncatalogued `provider/model` and select it. Repeat manual selection with the catalog unavailable.
4. Click every thinking level for each profile, including an uncatalogued model. Close and reopen Workflow, then restart only the test App and confirm the choices persist.
5. Open a fallback picker. Confirm the no-fallback choice and model choices are visible.
6. Reduce the window height until the profiles no longer fit. Confirm the body scrollbar appears and stays visible, then scroll to the final field. The header remains visible; there is no footer. Scroll an open picker independently of the body.

These checks exercise native layout and input; catalog and model-filter tests do not replace them.
