import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(here, '../src/pi_install.rs'), 'utf8');
const discovery = source.match(/\/\/ BEGIN_PI_RUNTIME_DISCOVERY\r?\n([\s\S]*?)\/\/ END_PI_RUNTIME_DISCOVERY/)[1];
const probe = (await readFile(path.join(here, 'pi-catalog.cjs'), 'utf8')).replace('__HERDR_DISCOVERY__', discovery);
function run(root) {
  const result = spawnSync(process.execPath, ['--input-type=commonjs', '-'], {
    input: probe, encoding: 'utf8', timeout: 30000, cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: root, PATH: path.resolve(here, '../integrations/orchestration/node_modules/.bin') + path.delimiter + process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.split(/\r?\n/).find(line => line.startsWith('herdr-pi-models:')).slice('herdr-pi-models:'.length));
}
async function fixture(work) {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-pi-catalog-'));
  try {
    await writeFile(path.join(root, 'models.json'), JSON.stringify({ providers: { 'herdr-catalog': {
      api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'HERDR_CATALOG_UNSET_KEY',
      models: ['first', 'second', 'excluded'].map(id => ({ id, name: id })),
    } } }));
    await mkdir(path.join(root, 'extensions'));
    await writeFile(path.join(root, 'extensions', 'must-not-load.ts'), 'throw new Error("A catalog lookup must not load user extensions");');
    await work(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('installed Pi resolves all scoped models without a live Pi or provider credentials', () => fixture(async root => {
  const settings = JSON.stringify({ enabledModels: ['herdr-catalog/first:high', 'herdr-catalog/sec*'] });
  await writeFile(path.join(root, 'settings.json'), settings);
  const before = await readdir(root);
  const catalog = run(root);
  assert.deepEqual(catalog.models.map(model => model.id).sort(), ['herdr-catalog/first', 'herdr-catalog/second']);
  assert.equal(catalog.source, 'pi-settings');
  assert.equal(catalog.error, undefined);
  assert.equal(await readFile(path.join(root, 'settings.json'), 'utf8'), settings);
  assert.deepEqual(await readdir(root), before);
}));
test('unresolved scope patterns expose diagnostics instead of silently widening the catalog', () => fixture(async root => {
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ enabledModels: ['herdr-catalog/missing'] }));
  const catalog = run(root);
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.diagnostics[0].pattern, 'herdr-catalog/missing');
}));
test('unreadable Pi settings report an error and do not claim an empty successful catalog', () => fixture(async root => {
  await writeFile(path.join(root, 'settings.json'), '{invalid');
  const catalog = run(root);
  assert.ok(catalog.error);
  assert.deepEqual(catalog.models, []);
}));
