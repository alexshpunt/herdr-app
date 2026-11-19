import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiIntegrationTest, assistantMessage, toolCall, text, getToolExecution, getToolExecutionDetails } from 'pi-coding-agent-test';
const here = path.dirname(fileURLToPath(import.meta.url));
test('new Pi sessions exclude disabled Workflow from the real tool_search catalog', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'herdr-feature-catalog-'));
  try {
    for (const workflow of [false, true]) {
      await writeFile(path.join(root, 'herdr-features.json'), JSON.stringify({ version: 1, workflow, usage: true, usageSince: 0 }));
      const run = await new PiIntegrationTest({
        testName: `herdr-feature-catalog-${workflow}`, cwd: root,
        artifactsDir: path.resolve(here, '../.tmp/test-runs'), transport: 'tui', rawMode: false,
        extensions: [path.resolve(here, '../index.ts'), 'builtin:tool-search', path.join(here, 'fixtures/features-probe.ts')],
        tools: ['tool_search', 'feature_probe'],
        environment: { PI_CODING_AGENT_DIR: root, HC_TERMINAL_ID: '', HC_TERMINAL_SOCKET: '' },
        conversation: [
          assistantMessage([toolCall({ id: 'search', name: 'tool_search', arguments: { query: 'agent' } })], { stopReason: 'toolUse' }),
          assistantMessage([toolCall({ id: 'probe', name: 'feature_probe', arguments: {} })], { stopReason: 'toolUse' }),
          assistantMessage([text('Catalog checked.')]),
        ],
      }).run('Search for the Herdr agent tool and inspect the catalog.');
      assert.equal(getToolExecution(run, 'search').isError, false);
      assert.equal(getToolExecution(run, 'probe').isError, false);
      const expected = workflow ? ['agent'] : [];
      assert.deepEqual(getToolExecutionDetails(getToolExecution(run, 'search')).loaded, expected);
      const probe = getToolExecutionDetails(getToolExecution(run, 'probe'));
      assert.deepEqual(probe.tools, expected);
      if (!workflow) assert.ok(!probe.sections.includes('herdr'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

const createInput = { requestId:'context-probe', name:'Context probe', message:'Fixture task', folder:path.resolve(here), profile:'feature' };
test('real Pi exposes a deferred catalog and refuses inherited or missing context safely', {timeout:60000}, async () => {
  const root = await mkdtemp(path.join(tmpdir(),'herdr-deferred-pi-'));
  try {
    const run = await new PiIntegrationTest({ testName:'herdr-deferred-catalog',cwd:root, artifactsDir:path.resolve(here,'../.tmp/test-runs'), isolateUserResources:true, transport:'tui', rawMode:false,
      extensions:[path.resolve(here,'../index.ts'),path.join(here,'fixtures/probe.ts')],tools:['herdr_catalog_probe'],
      environment:{HC_TERMINAL_ID:'',HC_TERMINAL_SOCKET:''},
      conversation:[assistantMessage([toolCall({id:'catalog',name:'herdr_catalog_probe',arguments:{}})],{stopReason:'toolUse'}),assistantMessage([toolCall({id:'missing',name:'agent',arguments:createInput})],{stopReason:'toolUse'}),assistantMessage([text('The missing Herdr context was refused.')])],
    }).run('Inspect the deferred Herdr tools, then create an agent without Herdr context.');
    assert.equal(getToolExecution(run,'catalog').isError,false);
    const catalog = getToolExecutionDetails(getToolExecution(run,'catalog'));
    assert.deepEqual(catalog.tools.map(tool=>tool.name), ['agent']);
    assert.ok(catalog.tools.every(tool=>tool.exposure==='deferred' && tool.namespace.name==='Herdr'));
    assert.ok(!catalog.active.some(name=>name === 'agent'));
    assert.equal(getToolExecution(run,'missing').isError,true);
    const rendered = await readFile(path.resolve(here,'../.tmp/test-runs/herdr-deferred-catalog/tui-rendered.log'),'utf8');
    assert.ok(rendered.length > 0);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('real Pi behind a wrapper shell stays quiet in a terminal it does not own', {timeout:60000}, async () => {
  const root = await mkdtemp(path.join(tmpdir(),'herdr-nested-pi-'));
  try {
    // The terminal's root and foreground process is the wrapper shell, PID 1 here, as for a replicate copy.
    // HC_BIN is Node itself, so `hc get t1 --json` runs the script `get` in Pi's working directory on every platform.
    const calls = path.join(root,'hc-calls.log'), hc = process.execPath;
    await writeFile(path.join(root,'get'), `require('node:fs').appendFileSync(${JSON.stringify(calls)}, ['get', ...process.argv.slice(2)].join(' ') + '\\n');\nprocess.stdout.write(JSON.stringify({ address: 't1', pid: 1, foreground: { pid: 1, name: 'bash' }, labels: {} }));\n`);
    const run = await new PiIntegrationTest({ testName:'herdr-nested-pi',cwd:root, artifactsDir:path.resolve(here,'../.tmp/test-runs'), isolateUserResources:true, transport:'tui', rawMode:false,
      extensions:[path.resolve(here,'../index.ts')],tools:['agent'],
      environment:{HC_TERMINAL_ID:'t1',HC_TERMINAL_SOCKET:path.join(root,'core.sock'),HC_BIN:hc},
      conversation:[assistantMessage([toolCall({id:'nested',name:'agent',arguments:createInput})],{stopReason:'toolUse'}),assistantMessage([text('The nested Pi stayed out of Herdr.')])],
    }).run('Create a Herdr agent from a nested Pi.');
    assert.equal(getToolExecution(run,'nested').isError,true);
    const rendered = await readFile(path.resolve(here,'../.tmp/test-runs/herdr-nested-pi/tui-rendered.log'),'utf8');
    assert.ok(rendered.length > 0);
    const invoked = (await readFile(calls,'utf8')).trim().split('\n');
    assert.ok(invoked.length > 0 && invoked.every(line => line === 'get t1 --json'), invoked.join('\n'));
  } finally { await rm(root,{recursive:true,force:true}); }
});