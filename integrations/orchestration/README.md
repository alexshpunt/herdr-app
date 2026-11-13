# Herdr Pi orchestration

Herdr App embeds this extension and installs it on each connected machine. Pi discovers it in the managed `extensions/herdr-orchestration` directory under its agent directory. Reload an already running Pi after an update. No runtime dependency installation is needed.

Herdr resolves the target machine's Pi npm entrypoint and starts it directly with Node. This preserves the first task's quotes and newlines and lets the core verify Pi's actual PID. The core restores a shell after Pi exits. A standalone binary or shell alias that cannot be resolved safely produces a launch error instead of guessing another command.

The six `herdr_agent_*` tools use Pi's native deferred exposure in the `Herdr` namespace. Discover them through `tool_search`. They manage independent user-owned agents in visible App tabs. Use `replicate` for the calling agent's own subtasks.

## Identity and transport

Only the terminal's own Pi publishes `herdr.pi`. Its version-1 label contains `pid`, `session`, the available model catalog (`models` with `id` and `name`), and `startup`. The catalog uses the scoped picker models when present, otherwise the authenticated model registry. Refresh happens on session load, model selection and before a run.

The App accepts a catalog only while the terminal is live and the label PID matches the terminal's root Pi process or its verified foreground process. Root identity also works before the core's first foreground sample and while Pi runs a child tool. Agent mutations also require the inspected PID and session. The requesting Pi's prompt includes its PID and exact App terminal, machine and space IDs after verifying its placement. A nested Pi cannot claim an inherited terminal.

Local `hc` verifies and labels the requesting terminal. The App publishes a private `herdr.app` route before launch. Requests travel back to that originating App through a bounded, versioned core document and a small label trigger, not an executable on the Pi machine. This works over the App's existing local/SSH connections, including machines unknown to the calling Pi's core. Requests are claimed with compare-and-set before dispatch; accepted or uncertain mutations are never replayed. App restarts change the route epoch. Missing routes require updating the App and reloading Pi.

Follow-up messages use the target Pi's authenticated local socket and `pi.sendUserMessage`, reached through `machine.exec`. They never type into terminal input: an exited or replaced Pi cannot turn a task message into a shell command. Socket credentials stay private in core labels and never enter tool results or the prompt.

## Startup and receipts

A successful assistant response, including a tool call, permanently changes startup to `started`. Reload preserves that boundary. A first-response error changes startup to `failed` only after Pi settles, allowing Pi's own automatic retries first. Later model errors never reopen startup fallback.

Create saves a write-ahead receipt under the Pi agent directory's `herdr-orchestration/requests`. Reuse a task's stable `requestId` and identical inputs after interruption. A repeated request returns its saved receipt without launching again. Concurrent callers cannot claim the same receipt. An unconfirmed launch is `unknown`; inspect Herdr before taking further action. Do not change the request key to retry it.

Create observes startup for up to 90 seconds. Only a verified first-response failure or early exit permits one configured fallback attempt. A blocked, cancelled, disconnected or timed-out observation leaves the existing agent intact and reports its state. The primary is rechecked before fallback. A recovered primary is not replaced. A failed primary stays available for inspection rather than being removed automatically: the user may resume it while fallback starts. Use explicit removal only at the user's request.

Workflow settings dock beside the entire App layout. Their compact controls follow the Spaces sidebar style. Primary model, fallback model and thinking level save on selection, without a Refresh button or footer. List returns those persisted profiles alongside agent identities. Create uses the selected profile unless explicit overrides are supplied.

## Checks

```sh
npm ci --prefix integrations/orchestration
npm run check --prefix integrations/orchestration
npm test --prefix integrations/orchestration
```

The suite covers request receipts, fallback boundaries and identity guards, plus real-Pi deferred registration, native tool error rendering and module refresh on reload. Run integration checks on the build worker. Verify the installed App and reloaded Pi when changing the runtime contract.

For installed-App verification without paid inference, copy `test/fixtures/live-provider.ts` into an isolated test project's `.pi/extensions/`. It registers `herdr-fixture/{controller,success,primary-error,fallback-error,late-error,slow}`. Use a separate `HERDR_APP_HOME`, `HC_SESSION` and `PI_CODING_AGENT_DIR`. The controller's first user message is JSON `{ "name": "herdr_agent_list", "arguments": {} }`; it calls that actual deferred tool and prints its result. Never install the fixture in personal extension settings. Remove the test App, its own core holder and project after verification.

### Workflow UI regression check

In the installed App, open Workflow for a machine with a live Pi catalog:

1. Open and close Workflow. Confirm the whole layout, including its header, narrows beside the dock and regains its width on close.
2. Open a primary model picker. Confirm model names and IDs are visible, then scroll to the last choice. Its scrollbar stays visible while the list overflows.
3. Search for a model by name or ID. Confirm filtering, an empty result, and clearing the search all update the visible list.
4. Select a different model and thinking level. Close and reopen Workflow, then restart only the App and confirm both choices persist. Restore the original profile afterward.
5. Open a fallback picker. Confirm the no-fallback choice and model choices are visible.
6. Reduce the window height until the profiles no longer fit. Confirm the body scrollbar appears and stays visible, then scroll to the final field. The header remains visible; there is no footer. Scroll an open picker independently of the body.

These checks exercise native layout and input; catalog and model-filter tests do not replace them.
