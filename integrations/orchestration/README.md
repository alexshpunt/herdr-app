# Herdr Pi orchestration

Herdr App embeds this extension and installs it on each connected machine. Pi discovers it in the managed `extensions/herdr-orchestration` directory under its agent directory. Reload an already running Pi after an update. No runtime dependency installation is needed.

The six `herdr_agent_*` tools use Pi's native deferred exposure in the `Herdr` namespace. Discover them through `tool_search`. They manage independent user-owned agents in visible App tabs. Use `replicate` for the calling agent's own subtasks.

## Identity and transport

Only the terminal's foreground Pi publishes `herdr.pi`. Its version-1 label contains `pid`, `session`, the available model catalog (`models` with `id` and `name`), and `startup`. The catalog uses the scoped picker models when present, otherwise the authenticated model registry. Refresh happens on session load, model selection and before a run.

The App accepts a catalog only while the terminal is live and the label PID matches its foreground process. Agent mutations also require the inspected PID and session. The requesting Pi's prompt includes its PID and exact App terminal, machine and space IDs after verifying its placement. A nested Pi cannot claim an inherited terminal.

Local `hc` verifies and labels the requesting terminal. The App publishes a private `herdr.app` route before launch. Requests travel back to that originating App through a bounded, versioned core document and a small label trigger, not an executable on the Pi machine. This works over the App's existing local/SSH connections, including machines unknown to the calling Pi's core. Requests are claimed with compare-and-set before dispatch; accepted or uncertain mutations are never replayed. App restarts change the route epoch. Missing routes require updating the App and reloading Pi.

Follow-up messages use the target Pi's authenticated local socket and `pi.sendUserMessage`, reached through `machine.exec`. They never type into terminal input: an exited or replaced Pi cannot turn a task message into a shell command. Socket credentials stay private in core labels and never enter tool results or the prompt.

## Startup and receipts

A successful assistant response, including a tool call, permanently changes startup to `started`. Reload preserves that boundary. A first-response error changes startup to `failed` only after Pi settles, allowing Pi's own automatic retries first. Later model errors never reopen startup fallback.

Create saves a write-ahead receipt under the Pi agent directory's `herdr-orchestration/requests`. Reuse a task's stable `requestId` and identical inputs after interruption. A repeated request returns its saved receipt without launching again. Concurrent callers cannot claim the same receipt. An unconfirmed launch is `unknown`; inspect Herdr before taking further action. Do not change the request key to retry it.

Create observes startup for up to 90 seconds. Only a verified first-response failure or early exit permits one configured fallback attempt. A blocked, cancelled, disconnected or timed-out observation leaves the existing agent intact and reports its state. The primary is rechecked before fallback. A recovered primary is not replaced. A failed primary stays available for inspection rather than being removed automatically: the user may resume it while fallback starts. Use explicit removal only at the user's request.

Workflow profiles and models live in the App's Workflow settings. List returns those profiles alongside agent identities. Create uses the selected profile unless explicit overrides are supplied.

## Checks

```sh
npm ci --prefix integrations/orchestration
npm run check --prefix integrations/orchestration
npm test --prefix integrations/orchestration
```

The suite covers request receipts, fallback boundaries and identity guards, plus real-Pi deferred registration, native tool error rendering and module refresh on reload. Run integration checks on the build worker. Verify the installed App and reloaded Pi when changing the runtime contract.

For installed-App verification without paid inference, copy `test/fixtures/live-provider.ts` into an isolated test project's `.pi/extensions/`. It registers `herdr-fixture/{controller,success,primary-error,fallback-error,late-error,slow}`. Use a separate `HERDR_APP_HOME`, `HC_SESSION` and `PI_CODING_AGENT_DIR`. The controller's first user message is JSON `{ "name": "herdr_agent_list", "arguments": {} }`; it calls that actual deferred tool and prints its result. Never install the fixture in personal extension settings. Remove the test App, its own core holder and project after verification.