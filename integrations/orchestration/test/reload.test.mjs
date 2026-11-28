import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestAgentMessage } from '../ipc.mjs';
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
const here=path.dirname(fileURLToPath(import.meta.url));
const clientModule=version=>`import {readFile,writeFile} from 'node:fs/promises';
export { workflowSelectionError } from ${JSON.stringify(new URL('../client.mjs', import.meta.url).href)};
const label=new URL('./label.json',import.meta.url);
export function importFresh(url){return import(url)}
export function ownsTerminal(terminal,pid){return terminal.pid===pid}
export class AppClient {
 async terminal(){return {pid:process.pid,labels:{'herdr.pi':await readFile(label,'utf8').catch(()=>'{}')}}}
 async owner(){return this.terminal()}
 async context(){return {pid:process.pid,session:'s',terminal:'m/t1',machine:'m',space:'m/sp1'}}
 async publish(value){await writeFile(label,JSON.stringify(value))}
 async command(name,args){return {version:${JSON.stringify(version)},name,args}}
 async tracked(name,toolCallId,run){return {id:'tracked-1',revision:'revision-1',result:await run(),toolCallId}}
 async recoveryList(){return [{id:'tracked-1',revision:'revision-1',state:'result'}]}
 async recoveryAck(input){return {items:input.items}}
 async replicate(args){return {replicated:args}}
 async workflow(){return {version:1,profiles:[]}}
}
`;
test('real Pi reload refreshes module code and never reopens the startup fallback boundary',{timeout:30000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'herdr-orchestration-reload-'));
 const prior=new Map(['HC_TERMINAL_ID','HC_TERMINAL_SOCKET','PI_CODING_AGENT_DIR'].map(key=>[key,process.env[key]]));
 let session;
 try {
  for(const file of ['index.ts','orchestration.mjs','ipc.mjs','inspect.mjs']) await copyFile(path.join(here,'..',file),path.join(root,file));
  await writeFile(path.join(root,'client.mjs'),clientModule('first'));
  process.env.HC_TERMINAL_ID='fixture';process.env.HC_TERMINAL_SOCKET='fixture';process.env.PI_CODING_AGENT_DIR=root;
  const bus=createEventBus(),settings=SettingsManager.inMemory();
  const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,eventBus:bus,additionalExtensionPaths:[path.join(root,'index.ts')],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
  await loader.reload();
  ({session}=await createAgentSession({cwd:root,agentDir:root,resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.inMemory()}));
  await session.bindExtensions({onError:error=>{throw error}});
  const bridge = () => { let api; bus.emit('herdr:bridge', { provide: value => { api = value; } }); assert.ok(api); return api; };
  assert.equal(bridge().version, 1);
  assert.equal((await bridge().command('agent.history', { terminal: 'm/t2' })).version, 'first');
  assert.equal((await bridge().command('agent.remove', { terminal: 'm/t2' })).name, 'agent.remove');
  const tracked = await bridge().commandTracked('agent.inspect', { terminal: 'm/t2' }, { toolCallId: 'tool-1' });
  assert.deepEqual(tracked, { id: 'tracked-1', revision: 'revision-1', toolCallId: 'tool-1', result: { version: 'first', name: 'agent.inspect', args: { terminal: 'm/t2' } } });
  assert.deepEqual(await bridge().recovery.list(), [{ id: 'tracked-1', revision: 'revision-1', state: 'result' }]);
  assert.deepEqual(await bridge().recovery.ack({ items: [{ id: tracked.id, revision: tracked.revision }] }), { items: [{ id: tracked.id, revision: tracked.revision }] });
  // A replica launch goes through the client's own validation, not a raw tab.new, one level deeper than its caller.
  assert.deepEqual(await bridge().command('agent.replicate', { name: 'r', depth: 9 }), { replicated: { name: 'r', depth: 1 } });
  assert.equal((await bridge().command('workflow.get', {})).name, 'workflow.get');
  // A sub-agent is a workflow-profile launch: a profile the App does not have starts nothing.
  await assert.rejects(bridge().command('agent.subagent', { requestId: 'sub-1', name: 'research', folder: root, profile: 'missing', task: 'Look it up.' }),
    /^Error: agent\.subagent refused: Unknown workflow profile missing\. Current profiles: none/);
  await assert.rejects(bridge().command('agent.subagent', { name: 'research' }), /agent\.subagent needs a non-empty requestId/);
  for (const name of ['agent.stop', 'space.new', 'tab.new']) assert.throws(() => bridge().command(name, {}));
  const label=async()=>JSON.parse(await readFile(path.join(root,'label.json'),'utf8'));
  assert.equal((await label()).startup,'pending');
  const snapshot = async () => {
    const route = await label();
    return requestAgentMessage(route, { action: 'inspect', pid: route.pid, session: route.session });
  };
  assert.equal((await label()).inspect, 1);
  assert.equal((await snapshot()).snapshot.busy, false);
  await session.extensionRunner.emit({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'quota'}});
  await session.extensionRunner.emit({type:'agent_settled',aborted:false});
  assert.equal((await label()).startup,'failed');
  assert.equal((await snapshot()).snapshot.lastError, 'quota');
  await session.extensionRunner.emit({type:'message_end',message:{role:'assistant',stopReason:'toolUse',content:[]}});
  assert.equal((await label()).startup,'started');
  await writeFile(path.join(root,'client.mjs'),clientModule('second'));
  // A successful response may be recorded even if publishing its label was interrupted.
  session.sessionManager.appendMessage({ role:'assistant', content:[{type:'text',text:'Started before publication'}], api:'openai-completions', provider:'fixture', model:'fixture', stopReason:'stop', timestamp:Date.now(), usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} });
  await writeFile(path.join(root,'label.json'),JSON.stringify({...(await label()),startup:'pending'}));
  await session.reload();
  assert.equal((await snapshot()).snapshot.events[0].text, 'Started before publication');
  assert.equal((await bridge().command('agent.inspect', { terminal: 'm/t2' })).version, 'second');
  const route = await label();
  const history = await requestAgentMessage(route, { action: 'history', pid: route.pid, session: route.session });
  assert.equal(history.outcome, 'history');
  assert.equal(history.items.at(-1).text, 'Started before publication');
  assert.equal((await label()).startup,'started');
  await session.extensionRunner.emit({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'later quota'}});
  await session.extensionRunner.emit({type:'agent_settled',aborted:false});
  const featurePath = path.join(root, 'herdr-features.json');
  await writeFile(featurePath, JSON.stringify({ version: 1, workflow: false, usage: true, usageSince: 0 }));
  await session.reload();
  assert.deepEqual(session.getAllTools().filter(tool => tool.name === 'agent'), []);
  let disabledBridge;
  bus.emit('herdr:bridge', { provide: value => { disabledBridge = value; } });
  assert.equal(disabledBridge, undefined);
  const event = { type: 'before_agent_start', prompt: 'fixture', systemPrompt: '', systemPromptOptions: { sections: {} } };
  await session.extensionRunner.emit(event);
  assert.equal(event.systemPromptOptions.sections.herdr, undefined);
  await writeFile(featurePath, JSON.stringify({ version: 1, workflow: true, usage: false, usageSince: 0 }));
  await session.reload();
  assert.deepEqual(session.getAllTools().filter(tool => tool.name === 'agent').map(tool => tool.name), ['agent']);
  assert.equal(bridge().version, 1);
  assert.equal((await label()).startup,'started');
 } finally {
  if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose()}
  for(const [key,value] of prior){if(value===undefined)delete process.env[key];else process.env[key]=value}
  await rm(root,{recursive:true,force:true});
 }
});
