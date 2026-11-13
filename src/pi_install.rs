//! Install the app's bundled, dependency-free Pi extension on the machine that
//! runs Pi. All payload bytes travel through machine.exec stdin, never shell
//! source. Call ensure off the UI thread before a Pi launch.

use crate::hc::Core;
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const FILES: &[(&str, &str)] = &[
    (
        "package.json",
        include_str!("../integrations/orchestration/package.json"),
    ),
    (
        "index.ts",
        include_str!("../integrations/orchestration/index.ts"),
    ),
    (
        "client.mjs",
        include_str!("../integrations/orchestration/client.mjs"),
    ),
    (
        "orchestration.mjs",
        include_str!("../integrations/orchestration/orchestration.mjs"),
    ),
    (
        "ipc.mjs",
        include_str!("../integrations/orchestration/ipc.mjs"),
    ),
    (
        "request.mjs",
        include_str!("../integrations/orchestration/request.mjs"),
    ),
];
const PREFIX: &str = "herdr-pi-install:";
const INSTALLER: &str = r###"
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const files = JSON.parse(Buffer.from('__HERDR_FILES_BASE64__', 'base64').toString('utf8'));
const marker = '.herdr-managed.json';
const owner = 'herdr-app';
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const optionalStat = async file => {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
};
// BEGIN_PI_RUNTIME_DISCOVERY
async function discoverPiRuntime(searchPath = process.env.PATH || '', platform = process.platform, extra) {
  const packageName = '@earendil-works/pi-coding-agent';
  const standard = extra ?? [path.dirname(process.execPath), path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'), ...(platform === 'win32' && process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm')] : [])];
  const directories = [...new Set([...searchPath.split(platform === 'win32' ? ';' : ':'), ...standard].filter(Boolean))];
  const names = platform === 'win32' ? ['pi.exe', 'pi.cmd', 'pi.ps1', 'pi'] : ['pi'];
  const nodeScript = async file => {
    const handle = await fs.open(file, 'r');
    let header;
    try { const bytes = Buffer.alloc(512); const result = await handle.read(bytes, 0, bytes.length, 0); header = bytes.subarray(0, result.bytesRead).toString('utf8'); }
    finally { await handle.close(); }
    if (!/^#![^\r\n]*\bnode(?:\.exe)?(?:\s|$)/.test(header)) throw new Error('The pi command is not a Node.js CLI; use the supported Pi npm installation before launching it from Herdr');
    return { launch: [process.execPath, await fs.realpath(file)] };
  };
  const fromPackage = async directory => {
    let metadata;
    try { metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined; throw error; }
    if (metadata.name !== packageName) return undefined;
    const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.pi;
    if (typeof bin !== 'string' || !bin) throw new Error('The installed Pi package has no pi entrypoint');
    const cli = path.resolve(directory, bin), relative = path.relative(directory, cli);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The installed Pi entrypoint is outside its package');
    return nodeScript(cli);
  };
  for (const directory of directories) for (const name of names) {
    const command = path.join(directory, name);
    try {
      let stat;
      try { stat = await fs.stat(command); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
      if (!stat.isFile()) continue;
      if (/\.(?:cmd|ps1)$/i.test(name)) {
        const shim = (await fs.readFile(command, 'utf8')).replaceAll('\\', '/');
        if (!shim.includes(packageName)) throw new Error('The pi command does not name the supported Pi npm package');
        const result = await fromPackage(path.join(directory, 'node_modules', '@earendil-works', 'pi-coding-agent'));
        if (!result) throw new Error('The Pi npm shim has no installed package beside it');
        return result;
      }
      const resolved = await fs.realpath(command);
      let parent = path.dirname(resolved);
      for (let level = 0; level < 8; level++) {
        const result = await fromPackage(parent);
        if (result) return result;
        const next = path.dirname(parent);
        if (next === parent) break;
        parent = next;
      }
      return await nodeScript(resolved);
    } catch (error) { return { launchError: `Cannot launch Pi directly: ${error.message}` }; }
  }
  return { launchError: 'Pi is not installed on this machine or is not on its PATH; install the Pi npm package and reconnect the machine' };
}
// END_PI_RUNTIME_DISCOVERY
(async () => {
  if (!Array.isArray(files) || !files.length || files.some(item => !Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(item[0]) || ['.', '..', marker].includes(item[0]) || typeof item[1] !== 'string') || new Set(files.map(item => item[0])).size !== files.length) throw new Error('Invalid bundled Pi resources');
  const revision = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const runtime = await discoverPiRuntime();
  const configured = process.env.PI_CODING_AGENT_DIR;
  const agent = configured ? path.resolve(configured === '~' ? os.homedir() : configured.startsWith('~/') || configured.startsWith('~\\') ? path.join(os.homedir(), configured.slice(2)) : configured) : path.join(os.homedir(), '.pi', 'agent');
  const extensions = path.join(agent, 'extensions');
  const target = path.join(extensions, 'herdr-orchestration');
  const lock = path.join(agent, '.herdr-orchestration-install.lock');
  const token = randomUUID();
  const stage = path.join(agent, `.herdr-orchestration-stage-${token}`);
  const backup = path.join(agent, `.herdr-orchestration-backup-${token}`);
  await fs.mkdir(extensions, { recursive: true });
  let held = false;
  const deadline = Date.now() + 20000;
  while (!held) {
    try {
      const handle = await fs.open(lock, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ owner, token, at: Date.now() })); held = true; }
      finally { await handle.close(); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Only a lock written by this installer can be reclaimed after the
      // bounded machine.exec that held it must have ended.
      let previous;
      try { previous = await readJson(lock); } catch { /* A writer may still be filling the lock. */ }
      if (previous?.owner === owner && typeof previous.token === 'string' && Number.isFinite(previous.at) && Date.now() - previous.at > 120000) {
        await fs.unlink(lock).catch(error => { if (error.code !== 'ENOENT') throw error; });
        continue;
      }
      if (Date.now() > deadline) throw new Error('Another Pi extension installation is still running; try again after it finishes');
      await delay(100);
    }
  }
  let moved = false;
  try {
    const existing = await optionalStat(target);
    let metadata;
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Refusing to replace an unmanaged Pi extension at ${target}`);
      try { metadata = await readJson(path.join(target, marker)); } catch { /* Missing metadata means this is not our directory. */ }
      if (metadata?.owner !== owner || !Array.isArray(metadata.files) || metadata.files.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name))) throw new Error(`Refusing to replace an unmanaged Pi extension at ${target}`);
      const allowed = new Set([...metadata.files, marker]);
      if ((await fs.readdir(target)).some(name => !allowed.has(name))) throw new Error(`The managed Pi extension contains personal files; move them out of ${target} before updating`);
      let unchanged = metadata.revision === revision;
      for (const [name, content] of files) {
        const stat = await optionalStat(path.join(target, name));
        if (!stat?.isFile() || stat.isSymbolicLink() || await fs.readFile(path.join(target, name), 'utf8') !== content) unchanged = false;
      }
      if (unchanged && metadata.files.length === files.length) {
        process.stdout.write('\nherdr-pi-install:' + JSON.stringify({ state: 'ready', path: target, revision, changed: false, ...runtime }) + '\n');
        return;
      }
    }
    // Stage and backup live outside extensions, so Pi never discovers a
    // temporary second copy while another process starts or reloads.
    await fs.mkdir(stage, { mode: 0o700 });
    for (const [name, content] of files) await fs.writeFile(path.join(stage, name), content, { mode: 0o600, flag: 'wx' });
    await fs.writeFile(path.join(stage, marker), JSON.stringify({ owner, revision, files: files.map(item => item[0]) }), { mode: 0o600, flag: 'wx' });
    if (existing) { await fs.rename(target, backup); moved = true; }
    try { await fs.rename(stage, target); }
    catch (error) {
      if (moved) {
        try { await fs.rename(backup, target); moved = false; }
        catch (restore) { throw new Error(`Pi extension update failed (${error.message}); the previous copy remains at ${backup}: ${restore.message}`); }
      }
      throw error;
    }
    if (moved) { await fs.rm(backup, { recursive: true }); moved = false; }
    process.stdout.write('\nherdr-pi-install:' + JSON.stringify({ state: 'ready', path: target, revision, changed: true, ...runtime }) + '\n');
  } finally {
    try { await fs.rm(stage, { recursive: true, force: true }); }
    finally {
      // Keep a backup if restoring it failed; never discard the last good copy.
      if (held) {
        let current;
        try { current = await readJson(lock); } catch { /* Leave an unknown lock alone. */ }
        if (current?.token === token) await fs.unlink(lock);
      }
    }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
"###;

#[derive(Default)]
struct Install {
    state: Mutex<State>,
    changed: Condvar,
}
#[derive(Default)]
enum State {
    #[default]
    Pending,
    Installing,
    Ready {
        receipt: Value,
        at: Instant,
    },
    Failed {
        error: String,
        at: Instant,
    },
}
static INSTALLS: OnceLock<Mutex<HashMap<Option<String>, Arc<Install>>>> = OnceLock::new();
// Keep verified prefixes while a later disk refresh is in flight; otherwise a
// queued UI launch could accidentally regain a shell wrapper during refresh.
static RUNTIMES: OnceLock<Mutex<Vec<Vec<String>>>> = OnceLock::new();
pub(crate) fn remember_runtime(receipt: &Value) {
    if let Ok(argv) = runtime_argv(receipt) {
        let mut runtimes = RUNTIMES
            .get_or_init(Mutex::default)
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !runtimes.contains(&argv) {
            runtimes.push(argv);
        }
    }
}

fn entry(on: Option<&str>) -> Arc<Install> {
    INSTALLS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .entry(on.map(str::to_owned))
        .or_default()
        .clone()
}

/// The drawer uses this to show installation failures without blocking the UI.
pub fn status(on: Option<&str>) -> Value {
    let install = entry(on);
    let state = install
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match &*state {
        State::Pending => json!({ "state": "pending" }),
        State::Installing => json!({ "state": "installing" }),
        State::Ready { receipt, .. } => receipt.clone(),
        State::Failed { error, .. } => json!({ "state": "error", "error": error }),
    }
}

/// Begin installation when a local or configured remote core becomes available.
/// Call ensure again from the existing background launch job before starting Pi.
pub fn start(core: Arc<Core>, on: Option<String>) {
    let record = entry(on.as_deref());
    if let Err(error) = std::thread::Builder::new()
        .name("pi-extension-install".into())
        .spawn(move || {
            if let Err(error) = ensure(&core, on.as_deref()) {
                tracing::warn!(machine = ?on, "cannot install the Herdr Pi extension: {error}");
            }
        })
    {
        let message = format!("Cannot start the Herdr Pi extension installer: {error}");
        *record
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = State::Failed {
            error: message.clone(),
            at: Instant::now(),
        };
        record.changed.notify_all();
        tracing::warn!("{message}");
    }
}

/// Ensure the complete bundled source is installed on the machine that runs Pi.
/// This may wait for an in-flight installation; do not call it on the UI thread.
pub fn ensure(core: &Core, on: Option<&str>) -> Result<(), String> {
    let install = entry(on);
    let mut state = install
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    loop {
        match &*state {
            State::Installing => {
                state = install
                    .changed
                    .wait(state)
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
            }
            // Recheck disk on subsequent launches; cache only a nearby startup
            // install so simultaneous creates share the same result.
            State::Ready { at, .. } if at.elapsed() < Duration::from_secs(5) => return Ok(()),
            State::Failed { error, at } if at.elapsed() < Duration::from_secs(5) => {
                return Err(error.clone())
            }
            _ => break,
        }
    }
    *state = State::Installing;
    drop(state);
    let result = install_on(core, on);
    let mut state = install
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match &result {
        Ok(receipt) => {
            remember_runtime(receipt);
            *state = State::Ready {
                receipt: receipt.clone(),
                at: Instant::now(),
            }
        }
        Err(error) => {
            *state = State::Failed {
                error: error.clone(),
                at: Instant::now(),
            }
        }
    }
    install.changed.notify_all();
    result.map(|_| ())
}

/// Resolve the target's own Node/Pi CLI after installing the extension. Native
/// argv keeps task text intact and makes Pi, not its shell, the terminal owner.
pub fn launch(core: &Core, on: Option<&str>) -> Result<Vec<String>, String> {
    ensure(core, on)?;
    runtime_argv(&status(on))
}
fn runtime_argv(receipt: &Value) -> Result<Vec<String>, String> {
    let argv = receipt["launch"]
        .as_array()
        .filter(|argv| argv.len() == 2)
        .and_then(|argv| {
            argv.iter()
                .map(|part| part.as_str().filter(|s| !s.is_empty()).map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        });
    argv.ok_or_else(|| {
        receipt["launchError"]
            .as_str()
            .unwrap_or(
                "Pi's native Node entrypoint is unavailable; install Pi and reconnect this machine",
            )
            .to_owned()
    })
}
/// Only installer-verified runtime prefixes bypass generic shell wrapping.
pub fn is_direct_pi(argv: &[String]) -> bool {
    if argv.len() < 2 {
        return false;
    }
    let Some(runtimes) = RUNTIMES.get() else {
        return false;
    };
    runtimes
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .any(|runtime| argv.starts_with(runtime))
}
#[derive(Debug)]
enum ExecFailure {
    Spawn(String),
    Other(String),
}
impl ExecFailure {
    fn message(self) -> String {
        match self {
            Self::Spawn(message) | Self::Other(message) => message,
        }
    }
}

fn install_on(core: &Core, on: Option<&str>) -> Result<Value, String> {
    let files = serde_json::to_vec(FILES).map_err(|error| error.to_string())?;
    let script = INSTALLER.replace(
        "__HERDR_FILES_BASE64__",
        &base64::engine::general_purpose::STANDARD.encode(files),
    );
    let input = base64::engine::general_purpose::STANDARD.encode(script);
    let result = execute_with(|argv| {
        core.call_timeout(
            "machine.exec",
            json!({ "on": on, "argv": argv, "input": input, "timeout": 45 }),
            Duration::from_secs(50),
        )
        .map_err(|error| {
            let message = format!("{error:#}");
            if crate::hc::error_kind(&error) == Some("spawn_failed") {
                ExecFailure::Spawn(message)
            } else {
                ExecFailure::Other(message)
            }
        })
    })
    .map_err(ExecFailure::message)?;
    receipt(&result)
}

// Retry PATH discovery only when Node was not started. A timeout, disconnect or
// installer failure has an unknown/known effect and must not rerun the payload.
fn execute_with(
    mut execute: impl FnMut(Vec<String>) -> Result<Value, ExecFailure>,
) -> Result<Value, ExecFailure> {
    match execute(vec![
        "node".into(),
        "--input-type=commonjs".into(),
        "-".into(),
    ]) {
        Err(ExecFailure::Spawn(_)) => {}
        other => return other,
    }
    let login = r#"shell=${SHELL:-/bin/sh}
case "${shell##*/}" in
  fish|sh|bash|zsh|dash|ksh) exec "$shell" -lic 'exec node --input-type=commonjs -' ;;
  *) exec sh -c 'exec node --input-type=commonjs -' ;;
esac"#;
    match execute(vec!["sh".into(), "-c".into(), login.into()]) {
        Err(ExecFailure::Spawn(_)) => {}
        Ok(result) if result["code"] == 127 && result["timed_out"] != true => {}
        other => return other,
    }
    // Windows cores can predate a Node PATH update. Keep data on stdin and
    // resolve only the application/standard Node install, not a shell function.
    let windows = r#"$ErrorActionPreference='Stop'; $node=(Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source; if (-not $node) { $candidate=Join-Path $env:ProgramFiles 'nodejs\node.exe'; if (Test-Path -LiteralPath $candidate) { $node=$candidate } }; if (-not $node) { throw 'Node.js is not available on this machine; install Node.js and reconnect the machine' }; & $node --input-type=commonjs -; exit $LASTEXITCODE"#;
    execute(vec![
        "powershell.exe".into(),
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-Command".into(),
        windows.into(),
    ])
}

fn receipt(result: &Value) -> Result<Value, String> {
    let decode = |field: &str| -> Result<String, String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(result[field].as_str().unwrap_or_default())
            .map_err(|error| format!("Invalid installer {field}: {error}"))?;
        String::from_utf8(bytes).map_err(|error| format!("Invalid installer {field}: {error}"))
    };
    if result["timed_out"] == true {
        return Err(
            "The Pi extension installation timed out; reconnect the machine and try again".into(),
        );
    }
    if result["code"].as_i64() != Some(0) {
        let error = decode("stderr")?;
        return Err(format!(
            "Pi extension installation failed (exit {}): {}",
            result["code"],
            error.trim().chars().take(4000).collect::<String>()
        ));
    }
    let output = decode("stdout")?;
    let value: Value = output
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix(PREFIX))
        .ok_or_else(|| "The Pi extension installer returned no confirmation".to_owned())
        .and_then(|line| {
            serde_json::from_str(line)
                .map_err(|error| format!("Invalid Pi extension installation confirmation: {error}"))
        })?;
    if value["state"] != "ready"
        || !value["revision"].as_str().is_some_and(|revision| {
            revision.len() == 64 && revision.bytes().all(|c| c.is_ascii_hexdigit())
        })
        || !value["path"].is_string()
    {
        return Err("The Pi extension installer returned an incomplete confirmation".into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(code: i32, output: &str) -> Value {
        json!({ "code": code, "stdout": base64::engine::general_purpose::STANDARD.encode(output), "stderr": "", "timed_out": false })
    }

    #[test]
    fn native_launches_use_only_installer_verified_runtime_prefixes() {
        let runtime = json!({"launch":["/herdr-native-test/node", "/herdr-native-test/pi.js"]});
        let mut argv = runtime_argv(&runtime).unwrap();
        assert!(!is_direct_pi(&argv));
        remember_runtime(&runtime);
        argv.extend([
            "--model".into(),
            "fixture/success".into(),
            "task with \"quotes\"\nand newline".into(),
        ]);
        assert!(is_direct_pi(&argv));
        argv[1] = "/another/cli.js".into();
        assert!(!is_direct_pi(&argv));
        assert!(runtime_argv(&json!({"launchError":"unavailable"})).is_err());
        assert!(runtime_argv(&json!({"launch":["node"]})).is_err());
    }
    #[test]
    fn parses_the_target_machine_confirmation_after_shell_greetings() {
        let expected = json!({ "state": "ready", "path": "C:\\Users\\Person\\.pi\\agent\\extensions\\herdr-orchestration", "revision": "a".repeat(64), "changed": true });
        let output = format!("login greeting\n{PREFIX}{expected}\n");
        assert_eq!(receipt(&result(0, &output)).unwrap(), expected);
        assert!(receipt(&result(1, &output)).is_err());
        assert!(receipt(&result(0, "")).is_err());
        assert!(receipt(&result(0, &format!("{PREFIX}{{\"state\":\"ready\"}}"))).is_err());
    }

    #[test]
    fn discovers_login_node_only_after_a_spawn_failure() {
        let mut commands = Vec::new();
        let output = execute_with(|argv| {
            commands.push(argv[0].clone());
            if commands.len() == 1 {
                Err(ExecFailure::Spawn("missing".into()))
            } else {
                Ok(result(0, ""))
            }
        })
        .unwrap();
        assert_eq!(commands, ["node", "sh"]);
        assert_eq!(output["code"], 0);
    }

    #[test]
    fn does_not_rerun_an_installer_with_failed_or_unknown_effects() {
        for code in [0, 1, 127] {
            let mut calls = 0;
            let _ = execute_with(|_| {
                calls += 1;
                Ok(result(code, ""))
            });
            assert_eq!(calls, 1);
        }
        let mut calls = 0;
        assert!(execute_with(|_| {
            calls += 1;
            Err(ExecFailure::Other("disconnected".into()))
        })
        .is_err());
        assert_eq!(calls, 1);
    }

    #[test]
    fn discovers_windows_node_only_when_the_posix_probe_could_not_start_it() {
        let mut commands = Vec::new();
        let _ = execute_with(|argv| {
            commands.push(argv[0].clone());
            match commands.len() {
                1 => Err(ExecFailure::Spawn("missing node".into())),
                2 => Ok(result(127, "")),
                _ => Ok(result(0, "")),
            }
        });
        assert_eq!(commands, ["node", "sh", "powershell.exe"]);
    }
}
