import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
const here=path.dirname(fileURLToPath(import.meta.url));
const clientModule=version=>`import {readFile,writeFile} from 'node:fs/promises';
const label=new URL('./label.json',import.meta.url);
export function importFresh(url){return import(url)}
export class AppClient {
 async owner(){return {labels:{'herdr.pi':await readFile(label,'utf8').catch(()=>'{}')}}}
 async context(){return {pid:process.pid,session:'s',terminal:'m/t1',machine:'m',space:'m/sp1'}}
 async publish(value){await writeFile(label,JSON.stringify(value))}
 async list(){return {version:${JSON.stringify(version)},agents:[]}}
}
`;
test('real Pi reload refreshes module code and never reopens the startup fallback boundary',{timeout:30000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'herdr-orchestration-reload-'));
 const prior=new Map(['HC_TERMINAL_ID','HC_TERMINAL_SOCKET'].map(key=>[key,process.env[key]]));
 let session;
 try {
  for(const file of ['index.ts','orchestration.mjs']) await copyFile(path.join(here,'..',file),path.join(root,file));
  await writeFile(path.join(root,'client.mjs'),clientModule('first'));
  process.env.HC_TERMINAL_ID='fixture';process.env.HC_TERMINAL_SOCKET='fixture';
  const bus=createEventBus(),settings=SettingsManager.inMemory();
  const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,eventBus:bus,additionalExtensionPaths:[path.join(root,'index.ts')],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
  await loader.reload();
  ({session}=await createAgentSession({cwd:root,agentDir:root,resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.inMemory()}));
  await session.bindExtensions({onError:error=>{throw error}});
  const request=()=>{
    session.setActiveToolsByName(['herdr_agent_list']);
    const tool=session.agent.state.tools.find(tool=>tool.name==='herdr_agent_list');
    assert.ok(tool,'Pi activated the deferred tool');
    return tool.execute('reload-probe',{},undefined,undefined);
  };
  assert.equal((await request()).structuredContent.version,'first');
  const label=async()=>JSON.parse(await readFile(path.join(root,'label.json'),'utf8'));
  assert.equal((await label()).startup,'pending');
  await session.extensionRunner.emit({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'quota'}});
  await session.extensionRunner.emit({type:'agent_settled',aborted:false});
  assert.equal((await label()).startup,'failed');
  await session.extensionRunner.emit({type:'message_end',message:{role:'assistant',stopReason:'toolUse',content:[]}});
  assert.equal((await label()).startup,'started');
  await writeFile(path.join(root,'client.mjs'),clientModule('second'));
  // A successful response may be recorded even if publishing its label was interrupted.
  session.sessionManager.appendMessage({ role:'assistant', content:[{type:'text',text:'Started before publication'}], api:'openai-completions', provider:'fixture', model:'fixture', stopReason:'stop', timestamp:Date.now(), usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} });
  await writeFile(path.join(root,'label.json'),JSON.stringify({...(await label()),startup:'pending'}));
  await session.reload();
  assert.equal((await request()).structuredContent.version,'second');
  assert.equal((await label()).startup,'started');
  await session.extensionRunner.emit({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'later quota'}});
  await session.extensionRunner.emit({type:'agent_settled',aborted:false});
  assert.equal((await label()).startup,'started');
 } finally {
  if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose()}
  for(const [key,value] of prior){if(value===undefined)delete process.env[key];else process.env[key]=value}
  await rm(root,{recursive:true,force:true});
 }
});
