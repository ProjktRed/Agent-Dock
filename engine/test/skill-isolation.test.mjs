import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {codexSkillArgs,clineSkillEnv} from '../src/skill-isolation.mjs';
import {CodexWorker} from '../src/codex-worker.mjs';
import {ClaudeWorker} from '../src/claude-worker.mjs';
import {CloudImplementationWorker,buildImplementationArgs} from '../src/cloud-impl-worker.mjs';
import {launchCline} from '../src/cline-cli-worker.mjs';
import * as cline from '../src/guard/adapters/cline.mjs';
import * as opencode from '../src/guard/adapters/opencode.mjs';
import {openCodeChildEnv} from '../src/opencode-cli-worker.mjs';
import {buildInitialPrompt} from '../src/workflow.mjs';

async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'skill-isolation-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const home=path.join(root,'home'),workspace=path.join(root,'repo','nested'),stateDir=path.join(root,'state'),codexHome=path.join(root,'codex-auth');
 await mkdir(workspace,{recursive:true});await mkdir(stateDir);await mkdir(codexHome);
 const env={HOME:home,USERPROFILE:home,CODEX_HOME:codexHome,OPENAI_API_KEY:'codex-auth',ANTHROPIC_API_KEY:'claude-auth'};
 const files=[];
 for(const base of [home,path.dirname(workspace),workspace])for(const folder of ['.agents','.claude','.opencode','.cline','.codex']) {
  const file=path.join(base,folder,'skills','probe','SKILL.md');await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,'---\nname: probe\ndescription: harmless isolation probe\n---\nDO_NOT_LOAD_PROBE_BODY\n');files.push(await realpath(file));
 }
 for(const sub of ['skills/system-probe','plugins/cache/test-plugin/skills/plugin-probe']) {
  const file=path.join(codexHome,sub,'SKILL.md');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'probe');files.push(await realpath(file));
 }
 await writeFile(path.join(codexHome,'auth.json'),'dummy auth, never read or copied');
 const task={id:'probe',prompt:'Task skill: implement\nFix x',allowedPaths:['x.js'],qaCommand:'npm test'};
 return {root,home,workspace,stateDir,env,files,task};
}

function disabledPaths(args) {
 const value=args.find(arg=>arg.startsWith('skills.config='));assert.ok(value);
 return [...value.matchAll(/\{path=("(?:\\.|[^"\\])*"),enabled=false\}/g)].map(match=>JSON.parse(match[1]));
}
function spawnRecorder(calls,cli) {
 return (command,args,options)=>{
  const child=new EventEmitter();child.pid=4242;child.exitCode=null;child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
  let prompt='';child.stdin.on('data',chunk=>prompt+=chunk);
  child.stdin.on('finish',()=>{(async()=>{
   calls.push({command,args,options,prompt});
   const result={status:'done',task:null,output:'OK',correction:'',commit:'',manualReviewCause:null};
   if(cli==='codex')await writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));
   else child.stdout.write(JSON.stringify({type:'result',is_error:false,result:JSON.stringify(result)}));
   child.stdout.end();child.stderr.end();child.exitCode=0;child.emit('close',0);
  })().catch(error=>child.emit('error',error));});
  return child;
 };
}

test('Codex disables discovered global, custom CODEX_HOME, ancestor, project and plugin skills without touching auth',async t=>{
 const f=await fixture(t),before={...f.env};
 const args=codexSkillArgs(f);
 assert.ok(args.includes('skills.include_instructions=false'));assert.ok(args.includes('skills.bundled.enabled=false'));
 for(const file of f.files)assert.ok(disabledPaths(args).includes(file),file);
 assert.deepEqual(f.env,before);
 assert.equal(await readFile(path.join(f.env.CODEX_HOME,'auth.json'),'utf8'),'dummy auth, never read or copied');
 const added=path.join(f.home,'.agents','skills','later','SKILL.md');await mkdir(path.dirname(added));await writeFile(added,'new probe');
 assert.ok(disabledPaths(codexSkillArgs(f)).includes(await realpath(added)),'fresh discovery on each launch');
 const otherHome=path.join(f.root,'windows-profile');const extra=path.join(otherHome,'.agents','skills','other','SKILL.md');
 await mkdir(path.dirname(extra),{recursive:true});await writeFile(extra,'other');
 assert.ok(disabledPaths(codexSkillArgs({...f,env:{...f.env,USERPROFILE:otherHome}})).includes(await realpath(extra)));
});

test('Codex canonicalizes linked skill directories and terminates cycles',async t=>{
 const f=await fixture(t),target=path.join(f.root,'linked'),link=path.join(f.home,'.agents','skills','linked');
 await mkdir(target);await writeFile(path.join(target,'SKILL.md'),'linked');
 await symlink(target,link,process.platform==='win32'?'junction':'dir');
 await symlink(target,path.join(target,'cycle'),process.platform==='win32'?'junction':'dir');
 assert.ok(disabledPaths(codexSkillArgs(f)).includes(await realpath(path.join(target,'SKILL.md'))));
});

for(const cli of ['codex','claude'])for(const kind of ['orchestrator','implementation'])test(`${cli} ${kind} launch carries isolation and protection hooks without moving auth`,async t=>{
 const f=await fixture(t),calls=[],spawnProcess=spawnRecorder(calls,cli),envBefore={...f.env};
 if(kind==='implementation') {
  const worker=new CloudImplementationWorker({...f,cli,command:cli,env:f.env,spawnProcess});
  await worker.run(buildInitialPrompt(f.task),{task:f.task});
 }else {
  const Worker=cli==='codex'?CodexWorker:ClaudeWorker;
  const worker=new Worker({...f,env:f.env,spawnProcess,writeProcessState:async()=>{},clearProcessState:async()=>{}});
  await worker.assess({objective:'Fix x'});
 }
 const call=calls[0];assert.equal(calls.length,1);assert.deepEqual(f.env,envBefore);
 assert.match(call.prompt,/Shared skill: bounded-task-handoff/);
 if(cli==='codex') {
  for(const file of f.files)assert.ok(disabledPaths(call.args).includes(file),file);
  assert.ok(call.args.some(arg=>arg.startsWith('hooks.PreToolUse=')));
  assert.equal(call.options.env.CODEX_HOME,f.env.CODEX_HOME);assert.equal(call.options.env.OPENAI_API_KEY,'codex-auth');
 }else {
  assert.ok(call.args.includes('--disable-slash-commands'));
  assert.ok(JSON.parse(call.args[call.args.indexOf('--settings')+1]).hooks.PreToolUse.length);
  assert.equal(call.options.env.ANTHROPIC_API_KEY,'claude-auth');
 }
});

test('implementation args disable skills even with editing guard off',async t=>{
 const f=await fixture(t);
 for(const cli of ['codex','claude']) {
  const args=buildImplementationArgs({...f,cli,task:f.task,toolGuard:false,outputFile:path.join(f.stateDir,'result')});
  assert.ok(cli==='codex'?disabledPaths(args).length:args.includes('--disable-slash-commands'));
 }
});

test('Cline overlays disabledTools without changing user settings and cleans up on completion',async t=>{
 const f=await fixture(t),source=path.join(f.root,'settings.json');
 const original=JSON.stringify({disabledTools:['web_search'],toolAutoApprove:false,custom:'keep'});await writeFile(source,original);
 const env={...f.env,CLINE_GLOBAL_SETTINGS_PATH:source};const isolation=await clineSkillEnv(env);
 const settings=JSON.parse(await readFile(isolation.env.CLINE_GLOBAL_SETTINGS_PATH,'utf8'));
 assert.deepEqual(settings,{disabledTools:['web_search','skills'],toolAutoApprove:false,custom:'keep'});
 assert.equal(await readFile(source,'utf8'),original);assert.equal(env.CLINE_GLOBAL_SETTINGS_PATH,source);
 await isolation.cleanup();await assert.rejects(readFile(isolation.env.CLINE_GLOBAL_SETTINGS_PATH),{code:'ENOENT'});
 // Actual engine launch, using a fake CLI to inspect the child environment.
 const script=path.join(f.root,'fake-cli.mjs'),log=path.join(f.root,'child.json');
 await writeFile(script,`import fs from 'node:fs';const p=process.env.CLINE_GLOBAL_SETTINGS_PATH;fs.writeFileSync(process.env.PROBE_LOG,JSON.stringify({path:p,settings:JSON.parse(fs.readFileSync(p,'utf8'))}));console.log(JSON.stringify({type:'run_result',finishReason:'completed',text:'OK'}));`);
 await launchCline({clineJs:script,workspace:f.workspace,prompt:'test',launchEnv:{...env,PROBE_LOG:log},timeoutSeconds:10});
 const child=JSON.parse(await readFile(log,'utf8'));assert.ok(child.settings.disabledTools.includes('skills'));
 await assert.rejects(readFile(child.path),{code:'ENOENT'});
 assert.equal(cline.allowedTools.includes('skills'),false);
 assert.equal(cline.toAction({hookName:'tool_call',tool_call:{name:'skills',input:{name:'probe'}}}).kind,'unknown');
});

test('OpenCode closes compatibility/home discovery and removes the skill tool from policy',async t=>{
 const f=await fixture(t),providerDescriptor={id:'openai',model:'probe',baseUrl:'http://127.0.0.1:1/v1'};
 const guard=await opencode.prepareOpenCodeGuard({...f,providerDescriptor,task:f.task});
 const hostile={...f.env,OPENCODE_DISABLE_EXTERNAL_SKILLS:'0',OPENCODE_CONFIG_DIR:f.home};
 const child=openCodeChildEnv(hostile,guard);
 assert.notEqual(child.HOME,f.home);assert.equal(child.USERPROFILE,child.HOME);
 assert.equal(child.OPENCODE_DISABLE_EXTERNAL_SKILLS,'1');assert.equal(child.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS,'1');
 assert.equal(child.OPENCODE_DISABLE_PROJECT_CONFIG,'1');assert.equal(child.OPENCODE_CONFIG_PROJECT_DISABLE,'1');
 const config=JSON.parse(child.OPENCODE_CONFIG_CONTENT);
 assert.ok(config.permissions.some(rule=>rule.action==='skill'&&rule.effect==='deny'));
 assert.ok(!config.experimental.policies.some(rule=>rule.action==='tool.use'&&rule.resource==='skill:*'&&rule.effect==='allow'));
 assert.equal(opencode.allowedTools.includes('skill'),false);assert.equal(opencode.toAction({tool:'skill',input:{name:'probe'}}).kind,'unknown');
 assert.equal(hostile.OPENCODE_CONFIG_DIR,f.home);
 // Other credentials in the engine's environment never reach OpenCode or its tools; its own provider variable does.
 const withKeys=openCodeChildEnv({...f.env,AGENT_DOCK_PROVIDER_KEY:'token',AGENT_DOCK_SUPERVISOR_KEY:'sv',ANTHROPIC_API_KEY:'a',OPENAI_API_KEY:'o'},guard,'AGENT_DOCK_PROVIDER_KEY');
 assert.equal(withKeys.AGENT_DOCK_PROVIDER_KEY,'token');
 for(const name of ['AGENT_DOCK_SUPERVISOR_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY'])assert.equal(withKeys[name],undefined,name);
});

test('Codex skill scan skips broken links and non-folder skill paths instead of failing the launch',async t=>{
 const {home,workspace,env,files}=await fixture(t);
 const skills=path.join(home,'.agents','skills');
 await symlink(path.join(home,'missing-target'),path.join(skills,'broken'),'junction').catch(()=>{});
 await rm(path.join(workspace,'.cline','skills'),{recursive:true,force:true});
 await writeFile(path.join(workspace,'.cline','skills'),'not a folder');
 const disabled=disabledPaths(codexSkillArgs({workspace,env}));
 const cline=path.join(await realpath(workspace),'.cline');
 for(const file of files.filter(f=>!f.includes(cline)))assert.ok(disabled.includes(file),file);
});
