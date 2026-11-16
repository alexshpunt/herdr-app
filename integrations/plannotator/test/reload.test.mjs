import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { requestBrowser } from '../ipc.mjs';

const integration = fileURLToPath(new URL('..', import.meta.url));
const browserModule = version => `
export async function openReview() { return { kind: 'embedded', pane: ${JSON.stringify(version)} }; }
export async function closeReview() {}
export async function resolveApp() { return ''; }
export async function runJson() { return {}; }
`;
const coreModule = (version, receipt) => `
import { writeFileSync } from 'node:fs';
export function resolveHc() { return process.execPath; }
export function ownsTerminal(terminal, pid) {
  writeFileSync(${JSON.stringify(receipt)}, ${JSON.stringify(version)});
  return terminal.pid === pid;
}
`;

async function waitForFile(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Missing fixture receipt: ${file}`);
}

test('Pi reload uses updated browser and core helpers and republishes its binding', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-reload-test-'));
  const keys = ['PLANNOTATOR_BROWSER', 'PLANNOTATOR_REMOTE', 'HERDR_PLANNOTATOR_SESSION_ID', 'HERDR_PLANNOTATOR_NODE', 'HERDR_PLANNOTATOR_SOCKET', 'HERDR_PLANNOTATOR_TOKEN', 'HERDR_PLANNOTATOR_MODE', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET'];
  const prior = new Map(keys.map(key => [key, process.env[key]]));
  let session;
  try {
    for (const file of ['index.ts', 'router.mjs', 'requested.mjs', 'ipc.mjs', 'fresh-import.mjs']) await copyFile(path.join(integration, file), path.join(root, file));
    const modulePath = path.join(root, 'open.mjs');
    const corePath = path.join(root, 'hc.mjs');
    const coreReceipt = path.join(root, 'core-version');
    const labelReceipt = path.join(root, 'binding');
    // Node runs the two external core stand-ins identically on Windows and Unix.
    await writeFile(path.join(root, 'get'), 'console.log(JSON.stringify({state:"live",pid:process.ppid}));');
    await writeFile(path.join(root, 'label'), `require('node:fs').writeFileSync(${JSON.stringify(labelReceipt)}, process.argv[3]);`);
    await writeFile(modulePath, browserModule('first'));
    await writeFile(corePath, coreModule('first', coreReceipt));
    for (const key of keys) delete process.env[key];
    process.env.HC_TERMINAL_ID = 'reload-fixture';
    process.env.HC_TERMINAL_SOCKET = 'reload-fixture-socket';
    process.env.PLANNOTATOR_BROWSER = path.join(root, process.platform === 'win32' ? 'open.cmd' : 'open.mjs');
    process.env.HERDR_PLANNOTATOR_SOCKET = path.join(root, 'previous.sock');
    const bus = createEventBus();
    const settings = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, eventBus: bus, additionalExtensionPaths: [path.join(root, 'index.ts')], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory() }));
    await session.bindExtensions({ onError: error => { throw error; } });
    const binding = async () => JSON.parse((await waitForFile(labelReceipt)).slice('herdr.plannotator='.length));
    const request = async (id) => {
      const url = `http://localhost:12345/${id}`;
      bus.emit('plannotator:session-opened', { id, piSessionId: session.sessionId, url });
      return requestBrowser(url);
    };
    const first = await binding();
    assert.equal(first.pid, process.pid);
    assert.equal(first.session, session.sessionId);
    assert.equal(await readFile(coreReceipt, 'utf8'), 'first');
    assert.equal((await request('pn-first')).pane, 'first');
    await rm(labelReceipt);
    await rm(coreReceipt);
    await writeFile(modulePath, browserModule('second'));
    await writeFile(corePath, coreModule('second', coreReceipt));
    await session.reload();
    const second = await binding();
    assert.notEqual(second.socket, first.socket);
    assert.equal(second.pid, process.pid);
    assert.equal(await readFile(coreReceipt, 'utf8'), 'second');
    assert.equal((await request('pn-second')).pane, 'second');
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
