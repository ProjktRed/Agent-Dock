import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseAssignedSkills,useAssignedSkills,managerHandoffSkill,autoSkillCatalogText} from '../src/task-handoff-skill.mjs';
import {parseLoopOptions} from '../src/loop-options.mjs';
import {buildInitialPrompt} from '../src/workflow.mjs';
import {buildRolePrompt} from '../src/workflow-roles.mjs';
import {CodexWorker,buildQaPrompt} from '../src/codex-worker.mjs';

const skill=(name,body)=>({name,instructions:`${body}\nSKILL_BODY_${name}`});
const file=roles=>({version:1,roles});
const task={id:'T',prompt:'Task skill: implement\nFix x',allowedPaths:['x.js'],qaCommand:'npm test'};

test('the skills file is validated before any role sees it',()=>{
 assert.throws(()=>parseAssignedSkills({roles:{}}),/version:1/);
 assert.throws(()=>parseAssignedSkills(file({worker:[skill('a','b')]})),/unknown role/);
 assert.throws(()=>parseAssignedSkills(file({qa:[{name:'bad/name',instructions:'x'}]})),/invalid skill name/);
 assert.throws(()=>parseAssignedSkills(file({qa:[{name:'empty',instructions:'  '}]})),/no instructions/);
 assert.throws(()=>parseAssignedSkills(file({qa:[{name:'big',instructions:'x'.repeat(16_001)}]})),/over 16000/);
 assert.throws(()=>parseAssignedSkills(file({qa:[1,2,3].map(n=>({name:'s'+n,instructions:'x'.repeat(15_000)}))})),/over 40000 characters in total/);
 assert.deepEqual(parseAssignedSkills(file({'role:review-1':[skill('ok','do it')]}))['role:review-1'].map(s=>s.name),['ok']);
});

test('custom instructions reach their own role prompt only, after the skills, and are validated',async t=>{
 t.after(()=>useAssignedSkills({}));
 assert.throws(()=>parseAssignedSkills({version:1,roles:{},notes:{worker:'x'}}),/notes for unknown role/);
 assert.throws(()=>parseAssignedSkills({version:1,roles:{},notes:{qa:'x'.repeat(4_001)}}),/over 4000/);
 assert.throws(()=>parseAssignedSkills({version:1,roles:{},notes:['x']}),/notes must be/);
 useAssignedSkills(parseAssignedSkills({version:1,roles:{implementation:[skill('tdd','Write the test first.')]},notes:{implementation:' NOTE_IMPL ',qa:'NOTE_QA','role:r-1':'NOTE_ROLE',assessment:'  '}}));
 const impl=buildInitialPrompt(task);
 assert.ok(impl.includes('NOTE_IMPL')&&!impl.includes('NOTE_QA'));
 assert.ok(impl.indexOf('SKILL_BODY_tdd')<impl.indexOf('NOTE_IMPL'),'notes follow the skills');
 assert.match(impl,/Custom instructions \(written by the user/);
 const qa=buildQaPrompt({task});
 assert.ok(qa.includes('NOTE_QA')&&!qa.includes('NOTE_IMPL'));
 assert.equal(managerHandoffSkill('assessment').includes('Custom instructions'),false,'blank notes are dropped');
 assert.ok(managerHandoffSkill('role:r-1').includes('NOTE_ROLE'));
});

test('each role prompt carries only its own assigned skills, after the engine guidance',async t=>{
 t.after(()=>useAssignedSkills({}));
 useAssignedSkills(parseAssignedSkills(file({
  implementation:[skill('tdd','Write the test first.')],qa:[skill('qa-check','Check edge cases.')],
  assessment:[skill('plan','Prefer small tasks.')],resolver:[skill('resolve','Explain the block.')],
  elevate:[skill('elevate','Question the strategy.')],'role:sec':[skill('sec','Look for secrets.')],
 })));
 const only=(prompt,name)=>{
  for(const other of ['tdd','qa-check','plan','resolve','elevate','sec'])assert.equal(prompt.includes('SKILL_BODY_'+other),other===name,`${name} prompt and ${other}`);
  assert.ok(prompt.indexOf(managerHandoffSkill().slice(0,60))<prompt.indexOf('Assigned skills'),'engine guidance comes first');
 };
 only(buildInitialPrompt(task),'tdd');
 only(buildQaPrompt({task}),'qa-check');
 only(buildRolePrompt({id:'sec',name:'Security',stage:'before-qa',instructions:'Review.'},{}),'sec');
 const worker=new CodexWorker({workspace:os.tmpdir(),stateDir:os.tmpdir()});
 const prompts=[];worker.invoke=async prompt=>{prompts.push(prompt);return {task};};
 await worker.assess({objective:'o'}).catch(()=>{});
 await worker.resolveBlocked({}).catch(()=>{});
 await worker.assessCorrection({}).catch(()=>{});
 await worker.reassessManualReview({}).catch(()=>{});
 ['plan','resolve','plan','elevate'].forEach((name,i)=>only(prompts[i],name));
});

test('no skills file means prompts are unchanged, and --skills-file loads at startup',async t=>{
 t.after(()=>useAssignedSkills({}));
 useAssignedSkills({});
 const plain=buildInitialPrompt(task);
 assert.ok(!plain.includes('Assigned skills'));
 const dir=await mkdtemp(path.join(os.tmpdir(),'assigned-skills-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const skillsFile=path.join(dir,'assigned-skills.json');
 await writeFile(skillsFile,JSON.stringify(file({implementation:[skill('tdd','Write the test first.')]})));
 parseLoopOptions(['--skills-file',skillsFile]);
 assert.ok(buildInitialPrompt(task).includes('SKILL_BODY_tdd'));
 parseLoopOptions([]);
 assert.equal(buildInitialPrompt(task),plain);
});

test('automatic skills: Assessment sees only the catalog, the worker gets the ones named in the task',async t=>{
 t.after(()=>useAssignedSkills({}));
 const auto=n=>({name:n,description:`Use for ${n} work.`,instructions:`AUTO_BODY_${n}`});
 assert.throws(()=>parseAssignedSkills({version:1,roles:{},auto:{qa:[]}}),/auto must be/);
 assert.throws(()=>parseAssignedSkills({version:1,roles:{},auto:{implementation:[{name:'x',description:' ',instructions:'y'}]}}),/needs a description/);
 useAssignedSkills(parseAssignedSkills({version:1,roles:{implementation:[skill('tdd','Write the test first.')]},
  auto:{implementation:['css','sql','auth','docs'].map(auto).concat([{...auto('tdd')}])}}));
 const worker=new CodexWorker({workspace:os.tmpdir(),stateDir:os.tmpdir()});
 const prompts=[];worker.invoke=async prompt=>{prompts.push(prompt);return {task};};
 await worker.assess({objective:'o'}).catch(()=>{});
 assert.match(prompts[0],/- css: Use for css work\./);
 assert.ok(!prompts[0].includes('AUTO_BODY_'),'Assessment never gets automatic skill bodies');
 assert.ok(!buildQaPrompt({task}).includes('- css:'),'only the choosing Assessment sees the catalog');
 const picked={...task,prompt:'Task skill: implement\nSkills: SQL, nope, css, auth, docs, tdd\nFix x'};
 const prompt=buildInitialPrompt(picked);
 for(const n of ['sql','css','auth'])assert.ok(prompt.includes('AUTO_BODY_'+n),n);
 assert.ok(!prompt.includes('AUTO_BODY_docs'),'at most 3 are used');
 assert.equal(prompt.split('## Skill: tdd').length,2,'always-assigned tdd appears once');
 assert.ok(!buildInitialPrompt(task).includes('AUTO_BODY_'),'no Skills line, no automatic skills');
});

test('automatic skills from the index: only a picked skill is read from disk, frontmatter removed, references included',async t=>{
 t.after(()=>useAssignedSkills({}));
 const root=await mkdtemp(path.join(os.tmpdir(),'auto-index-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const make=async(name,body,refs={})=>{const dir=path.join(root,name);await mkdir(path.join(dir,'references'),{recursive:true});
  await writeFile(path.join(dir,'SKILL.md'),`---\nname: ${name}\ndescription: ${name} work\n---\n${body}\n`);
  for(const [f,text] of Object.entries(refs))await writeFile(path.join(dir,'references',f),text);return dir;};
 const css=await make('css','CSS_BODY',{'grid.md':'GRID_REF'}),sql=await make('sql','SQL_BODY');
 useAssignedSkills(parseAssignedSkills({version:1,roles:{},auto:{implementation:[
  {name:'css',description:'Styling and layout.',dir:css},{name:'sql',description:'Database queries.',dir:sql},{name:'gone',description:'Deleted skill.',dir:path.join(root,'missing')}]}}));
 const catalog=autoSkillCatalogText();
 assert.match(catalog,/- css: Styling and layout\./);
 assert.ok(!catalog.includes('CSS_BODY'),'the catalog never holds skill text');
 const prompt=buildInitialPrompt({...task,prompt:'Task skill: implement\nSkills: css, gone\nFix x'});
 assert.ok(prompt.includes('CSS_BODY')&&prompt.includes('### File: references/grid.md\nGRID_REF'));
 assert.ok(!prompt.includes('name: css'),'frontmatter is removed');
 assert.ok(!prompt.includes('SQL_BODY'),'unpicked skills are not read into the prompt');
 assert.ok(!prompt.includes('## Skill: gone'),'a missing folder is skipped');
 assert.throws(()=>parseAssignedSkills({version:1,roles:{},auto:{implementation:[{name:'x',description:'d',dir:'relative/path'}]}}),/folder or instructions/);
});
