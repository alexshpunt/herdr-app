// A kept Herdr terminal gets a plain shell after its program is lost to a
// reboot, a stopped core or a lost holder. This module tells the core how to
// reopen this Pi's session there instead (`terminal.keep` with `recover`).
// The core runs that command once, only after a loss; ordinary exits and kills
// stay final. A deliberate quit forgets it, so a closed Pi does not come back.
import { runJson, resolveHc, ownsTerminal } from './client.mjs';

const HERDR_FLAGS = ['herdr-workflow-model', 'herdr-workflow-thinking', 'herdr-depth'];

/** The command that reopens this Pi's session file with Herdr's own launch flags, never a task message. */
export function resumeArgv({ execPath, script, sessionFile, flags = {} }) {
  if (!execPath || !script || !sessionFile) return undefined;
  const herdr = HERDR_FLAGS.flatMap(name => typeof flags[name] === 'string' && flags[name] ? [`--${name}`, flags[name]] : []);
  return [execPath, script, '--session', sessionFile, ...herdr];
}

// Pi ends the same way on SIGTERM/SIGHUP as on /quit (session_shutdown with
// reason "quit"). A signal comes from a shutdown or a closed terminal, not from
// the user leaving Pi, so it must not forget the recovery command. Listeners
// stay registered once per process across extension reloads.
const SIGNALLED = Symbol.for('herdr-orchestration.resume.signalled');
function watchSignals(processObject) {
  if (processObject[SIGNALLED]) return processObject[SIGNALLED];
  const state = { signalled: false };
  processObject[SIGNALLED] = state;
  for (const signal of ['SIGTERM', 'SIGHUP']) {
    // First, so the flag is set before Pi's own handler starts its shutdown.
    // Alone, it would swallow the signal: then let the default action end the process.
    const listener = () => {
      state.signalled = true;
      if (processObject.listenerCount(signal) > 1) return;
      processObject.removeListener(signal, listener);
      processObject.kill(processObject.pid, signal);
    };
    try { processObject.prependListener(signal, listener); } catch { /* Not supported on this platform. */ }
  }
  return state;
}

/**
 * Keep the core's recovery command in step with the session this Pi shows.
 * `core(method, params)` reaches the terminal's core; tests replace it.
 */
export function createResume({ pid = process.pid, env = process.env, argv = process.argv, execPath = process.execPath, processObject = process, core } = {}) {
  const terminal = env.HC_TERMINAL_ID;
  const call = core ?? ((method, params) => {
    const hc = resolveHc({ env });
    // Short: a deliberate quit waits for the last call.
    const options = { timeout: 5000 };
    if (method === 'terminal.get') return runJson(hc, ['get', params.terminal, '--json'], options);
    const args = ['keep', params.terminal, '--json', ...(params.recover.length ? ['--', ...params.recover] : ['--no-recover'])];
    return runJson(hc, args, options);
  });
  const signals = watchSignals(processObject);
  let current;
  let queue = Promise.resolve();
  const enqueue = work => (queue = queue.catch(() => {}).then(work));
  // Only a terminal the App keeps: setting a recovery command must not make another terminal kept.
  const eligible = async () => {
    const record = await call('terminal.get', { terminal });
    return record?.keep === true && ownsTerminal(record, pid);
  };
  return {
    /** Point the recovery command at this session; a nested Pi leaves the terminal's own alone. */
    update({ sessionFile, flags }) {
      if (!terminal || !env.HC_TERMINAL_SOCKET) return queue;
      const wanted = resumeArgv({ execPath, script: argv[1], sessionFile, flags });
      return enqueue(async () => {
        if (!wanted || JSON.stringify(wanted) === JSON.stringify(current)) return;
        if (!await eligible()) return;
        await call('terminal.keep', { terminal, recover: wanted });
        current = wanted;
      });
    },
    /** Forget it after a deliberate quit; a signal or a session switch keeps it. */
    shutdown(reason) {
      if (!terminal || !env.HC_TERMINAL_SOCKET || reason !== 'quit' || signals.signalled || !current) return queue;
      return enqueue(async () => {
        if (!current || signals.signalled) return;
        await call('terminal.keep', { terminal, recover: [] });
        current = undefined;
      });
    },
  };
}
