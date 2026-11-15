import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiIntegrationTest, assistantMessage, toolCall, text, getToolExecution, getToolExecutionDetails, getToolResultText } from 'pi-coding-agent-test';
const here = path.dirname(fileURLToPath(import.meta.url));
test('real Pi exposes a deferred catalog and refuses inherited or missing context safely', {timeout:60000}, async () => {
  const root = await mkdtemp(path.join(tmpdir(),'herdr-deferred-pi-'));
  try {
    const run = await new PiIntegrationTest({ testName:'herdr-deferred-catalog',cwd:root, artifactsDir:path.resolve(here,'../.tmp/test-runs'), isolateUserResources:true, transport:'tui', rawMode:false,
      extensions:[path.resolve(here,'../index.ts'),path.join(here,'fixtures/probe.ts')],tools:['herdr_catalog_probe'],
      environment:{HC_TERMINAL_ID:'',HC_TERMINAL_SOCKET:''},
      conversation:[assistantMessage([toolCall({id:'catalog',name:'herdr_catalog_probe',arguments:{}})],{stopReason:'toolUse'}),assistantMessage([toolCall({id:'missing',name:'herdr_agent_list',arguments:{}})],{stopReason:'toolUse'}),assistantMessage([text('The missing Herdr context was refused.')])],
    }).run('Inspect the deferred Herdr tools, then list agents without Herdr context.');
    assert.equal(getToolExecution(run,'catalog').isError,false);
    const catalog = getToolExecutionDetails(getToolExecution(run,'catalog'));
    assert.equal(catalog.tools.length,6);
    assert.ok(catalog.tools.every(tool=>tool.exposure==='deferred' && tool.namespace.name==='Herdr'));
    assert.ok(!catalog.active.some(name=>name.startsWith('herdr_agent_')));
    assert.equal(getToolExecution(run,'missing').isError,true);
    assert.match(getToolResultText(run,'missing'),/Herdr agent context is unavailable/);
    const rendered = await readFile(path.resolve(here,'../.tmp/test-runs/herdr-deferred-catalog/tui-rendered.log'),'utf8');
    assert.match(rendered.replace(/\s+/g,' '), /Herdr agent context is unavailable/);
    assert.doesNotMatch(rendered, /Herdr list\s+Applied/);
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
      extensions:[path.resolve(here,'../index.ts')],tools:['herdr_agent_list'],
      environment:{HC_TERMINAL_ID:'t1',HC_TERMINAL_SOCKET:path.join(root,'core.sock'),HC_BIN:hc},
      conversation:[assistantMessage([toolCall({id:'nested',name:'herdr_agent_list',arguments:{}})],{stopReason:'toolUse'}),assistantMessage([text('The nested Pi stayed out of Herdr.')])],
    }).run('List Herdr agents from a nested Pi.');
    assert.equal(getToolExecution(run,'nested').isError,true);
    assert.match(getToolResultText(run,'nested'),/Herdr agent context is unavailable/);
    const rendered = await readFile(path.resolve(here,'../.tmp/test-runs/herdr-nested-pi/tui-rendered.log'),'utf8');
    assert.doesNotMatch(rendered, /Herdr agents:/);
    const invoked = (await readFile(calls,'utf8')).trim().split('\n');
    assert.ok(invoked.length > 0 && invoked.every(line => line === 'get t1 --json'), invoked.join('\n'));
  } finally { await rm(root,{recursive:true,force:true}); }
});