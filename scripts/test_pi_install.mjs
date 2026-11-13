import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(here, '../src/pi_install.rs'), 'utf8');
const installer = source.match(/const INSTALLER: &str = r###"([\s\S]*?)"###;/)?.[1];
assert.ok(installer, 'The bundled installer must have a readable script');
const files = [['package.json', '{"pi":{"extensions":["./index.ts"]}}'], ['index.ts', 'export default function extension() {}']];
const marker = '.herdr-managed.json';
const scriptFor = runtime => installer.replace('__HERDR_FILES_BASE64__', Buffer.from(JSON.stringify(runtime)).toString('base64'));
function run(root, runtime = files) {
  const script = scriptFor(runtime);
  const result = spawnSync(process.execPath, ['--input-type=commonjs', '-'], {
    input: script, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PI_CODING_AGENT_DIR: root },
  });
  const receipt = result.stdout.split(/\r?\n/).find(line => line.startsWith('herdr-pi-install:'));
  return { ...result, receipt: receipt ? JSON.parse(receipt.slice('herdr-pi-install:'.length)) : undefined };
}
async function fixture(work) {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-pi-installer-'));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('installs bundled resources without modifying Pi settings or other extensions', () => fixture(async root => {
  await mkdir(path.join(root, 'extensions', 'personal'), { recursive: true });
  await writeFile(path.join(root, 'settings.json'), '{"model":"personal"}');
  await writeFile(path.join(root, 'extensions', 'personal', 'index.ts'), 'personal source');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.receipt.state, 'ready');
  for (const [name, content] of files) assert.equal(await readFile(path.join(root, 'extensions', 'herdr-orchestration', name), 'utf8'), content);
  assert.equal(await readFile(path.join(root, 'settings.json'), 'utf8'), '{"model":"personal"}');
  assert.equal(await readFile(path.join(root, 'extensions', 'personal', 'index.ts'), 'utf8'), 'personal source');
}));
test('reuses unchanged resources and repairs a changed managed file', () => fixture(async root => {
  assert.equal(run(root).status, 0);
  const target = path.join(root, 'extensions', 'herdr-orchestration');
  const before = await lstat(path.join(target, 'index.ts'));
  const second = run(root);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.receipt.changed, false);
  assert.equal((await lstat(path.join(target, 'index.ts'))).mtimeMs, before.mtimeMs);
  await writeFile(path.join(target, 'index.ts'), 'changed managed source');
  const repaired = run(root);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(repaired.receipt.changed, true);
  assert.equal(await readFile(path.join(target, 'index.ts'), 'utf8'), files[1][1]);
}));
test('upgrades the complete managed directory and removes obsolete managed files', () => fixture(async root => {
  assert.equal(run(root, [...files, ['obsolete.mjs', 'old']]).status, 0);
  const result = run(root, [['package.json', files[0][1]], ['index.ts', 'new source']]);
  assert.equal(result.status, 0, result.stderr);
  const target = path.join(root, 'extensions', 'herdr-orchestration');
  assert.equal(await readFile(path.join(target, 'index.ts'), 'utf8'), 'new source');
  await assert.rejects(lstat(path.join(target, 'obsolete.mjs')), { code: 'ENOENT' });
  const metadata = JSON.parse(await readFile(path.join(target, marker), 'utf8'));
  assert.equal(metadata.owner, 'herdr-app');
  assert.deepEqual(metadata.files.sort(), ['index.ts', 'package.json']);
}));
test('refuses to replace an unrelated directory or discard personal files', () => fixture(async root => {
  const target = path.join(root, 'extensions', 'herdr-orchestration');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'index.ts'), 'personal');
  assert.notEqual(run(root).status, 0);
  assert.equal(await readFile(path.join(target, 'index.ts'), 'utf8'), 'personal');
  await rm(target, { recursive: true });
  assert.equal(run(root).status, 0);
  await writeFile(path.join(target, 'notes.txt'), 'personal notes');
  assert.notEqual(run(root).status, 0);
  assert.equal(await readFile(path.join(target, 'notes.txt'), 'utf8'), 'personal notes');
}));
test('rejects path traversal before it changes any installed files', () => fixture(async root => {
  const result = run(root, [['../escape.txt', 'no']]);
  assert.notEqual(result.status, 0);
  await assert.rejects(lstat(path.join(root, 'escape.txt')), { code: 'ENOENT' });
}));

test('refuses to follow a personal extension symlink', () => fixture(async root => {
  const personal = path.join(root, 'personal');
  await mkdir(personal);
  await writeFile(path.join(personal, 'index.ts'), 'personal');
  await mkdir(path.join(root, 'extensions'));
  await symlink(personal, path.join(root, 'extensions', 'herdr-orchestration'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.notEqual(run(root).status, 0);
  assert.equal(await readFile(path.join(personal, 'index.ts'), 'utf8'), 'personal');
}));

test('serializes concurrent installations into one complete managed copy', () => fixture(async root => {
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=commonjs', '-'], { env: { ...process.env, PI_CODING_AGENT_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
    child.stdin.end(scriptFor(files));
  });
  const results = await Promise.all([launch(), launch(), launch()]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const target = path.join(root, 'extensions', 'herdr-orchestration');
  for (const [name, content] of files) assert.equal(await readFile(path.join(target, name), 'utf8'), content);
  await assert.rejects(lstat(path.join(root, '.herdr-orchestration-install.lock')), { code: 'ENOENT' });
}));