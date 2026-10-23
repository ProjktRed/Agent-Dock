import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {redactDeep,redactText,secretValuesFromEnv,useSecretValues} from '../src/redact.mjs';
import {DashboardState} from '../src/dashboard-state.mjs';
import {flushNotifications,notify,useNotify} from '../src/notify.mjs';
import {buildInitialPrompt} from '../src/workflow.mjs';
import {verifyActionLog} from '../src/action-log.mjs';

const GH='ghp_'+'a1B2'.repeat(9), OPENAI='sk-proj-'+'Xy9_'.repeat(8), ANTHROPIC='sk-ant-api03-'+'Q7w'.repeat(10);

test('well-known credential formats are hidden and named; ordinary text is left alone',t=>{
 t.after(()=>useSecretValues(secretValuesFromEnv()));useSecretValues([]);
 const text=[`token ${GH}`,`key ${OPENAI}`,`claude ${ANTHROPIC}`,'aws AKIAABCDEFGHIJKLMNOP','google AIza'+'b'.repeat(35),
  'hook https://discord.com/api/webhooks/123456/abcDEF_ghi','slack https://hooks.slack.com/services/T000/B000/XXXX','bot 123456789:'+'A'.repeat(35),
  'jwt eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4fw','-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
  'Authorization: Bearer abcdefghijklmnop1234','API_KEY=abc123def456ghi','password: hunter2hunter'].join('\n');
 const out=redactText(text);
 for(const secret of [GH,OPENAI,ANTHROPIC,'AKIAABCDEFGHIJKLMNOP','abcDEF_ghi','XXXX','SflKxwRJ','MIIE','abcdefghijklmnop1234','abc123def456ghi','hunter2hunter'])assert.ok(!out.includes(secret),`hidden: ${secret}`);
 for(const kind of ['github-token','openai-key','anthropic-key','aws-key','google-key','discord-webhook','slack-webhook','telegram-token','jwt','private-key','bearer-token','secret'])assert.ok(out.includes(`[redacted:${kind}]`),`named: ${kind}`);
 assert.match(out,/API_KEY=\[redacted:secret\]/,'the name stays readable');
 const plain='Tokens 280,786 counted; tokens: 30000000; commit 3eafc11; const apiKey = getKey(); see src/index.js at HEAD~2';
 assert.equal(redactText(plain),plain);
 assert.equal(redactText('const apiKey = "abc123def456ghi"',{assignments:false}),'const apiKey = "abc123def456ghi"','prompts keep code readable');
});

test('exact secret values are hidden everywhere, including inside URLs; env and AGENT_DOCK_NOTIFY are read',t=>{
 t.after(()=>useSecretValues(secretValuesFromEnv()));
 const env={PATH:'C:\\Windows',AGENT_DOCK_PROVIDER_KEY:'local-key-123456',HOME_DIR:'C:\\Users\\me',MY_TOKEN:'short',
  AGENT_DOCK_NOTIFY:JSON.stringify({project:'Demo',webhook:'https://hooks.example.com/abc/def123',telegram:{token:'111111:'+'T'.repeat(35),chatId:'4242'},email:{apiKey:'am_live_zzzzzzzzzzzz',inbox:'bot@agentmail.to',to:['me@example.com']},digests:true})};
 const values=secretValuesFromEnv(env);
 assert.ok(values.includes('local-key-123456')&&values.includes('https://hooks.example.com/abc/def123')&&values.includes('am_live_zzzzzzzzzzzz'));
 assert.ok(!values.includes('C:\\Windows')&&!values.includes('Demo')&&!values.includes('short'));
 useSecretValues(values);
 assert.equal(redactText('posting to https://hooks.example.com/abc/def123 with local-key-123456',{patterns:false}),'posting to [redacted:secret] with [redacted:secret]');
 assert.deepEqual(redactDeep({a:['x am_live_zzzzzzzzzzzz'],n:5,b:{c:'ok'}}),{a:['x [redacted:secret]'],n:5,b:{c:'ok'}});
});

test('Activity, the action log, notifications and prompts never carry a secret',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'redact-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const state=new DashboardState({stateDir:dir});await state.initialize({task:{id:'T',prompt:'p'},workspace:dir});
 await state.record({type:'blocked',qa:`npm test printed ${GH}`});
 for(const file of ['activity.ndjson','action-log.ndjson','live.json'])assert.ok(!(await readFile(path.join(dir,file),'utf8')).includes(GH),file);
 assert.equal((await verifyActionLog(dir)).ok,true,'the chain covers the redacted entries');
 const sent=[];t.after(()=>useNotify());
 useNotify({webhook:'https://hooks.example.com/x'},{fetchImpl:async(url,init)=>{sent.push(init.body);return{ok:true};}});
 notify({type:'blocked',title:'Run blocked',message:`leaked ${OPENAI}`});await flushNotifications();
 assert.ok(!sent[0].includes(OPENAI)&&sent[0].includes('[redacted:openai-key]'));
 const prompt=buildInitialPrompt({id:'T',prompt:`Use the key ${ANTHROPIC} to call the API`,allowedPaths:['a.js'],qaCommand:'npm test'});
 assert.ok(!prompt.includes(ANTHROPIC)&&prompt.includes('[redacted:anthropic-key]'));
});

// Retest (0.38.1): a registered secret under 8 characters was not redacted.
test('secrets by name are hidden however short; live.json keeps no known secret in a prompt',async t=>{
  t.after(()=>useSecretValues(secretValuesFromEnv()));
  useSecretValues(secretValuesFromEnv({AGENT_DOCK_PROVIDER_KEY:'k7Qz9',MONKEY:'true'}));
  assert.equal(redactText('key k7Qz9 and true'),'key [redacted:secret] and true');
  const dir=await mkdtemp(path.join(os.tmpdir(),'redact-live-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const state=new DashboardState({stateDir:dir});
  await state.initialize({task:{id:'T',prompt:'use the key k7Qz9'},workspace:dir,maxAttempts:1});
  assert.doesNotMatch(await readFile(path.join(dir,'live.json'),'utf8'),/k7Qz9/);
});
