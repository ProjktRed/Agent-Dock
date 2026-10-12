import test from 'node:test';import assert from 'node:assert/strict';
import * as progress from '../src/implementation-progress.mjs';
const plan='## Phase 0 — Foundation\n- [x] Setup\n## Phase 1 — Companion\n- [x] Registry\n- [ ] Manual import\n  - [x] Service\n  - [ ] Native dialog\n## Phase 2 — Intelligence\n- [ ] Builds\n## Phase 3 — Community\n- [ ] Stats\n';
test('all actual phases and checklist counts come from the plan, with active task separate',()=>{
 assert.equal(typeof progress.parseImplementationPlan,'function');const p=progress.parseImplementationPlan(plan,{id:'P1-004-test',name:'Run native dialog'});
 assert.equal(p.phases.length,4);assert.equal(p.completed,3);assert.equal(p.total,7);assert.equal(p.currentPhase,1);assert.equal(p.phases[1].title,'Companion');assert.equal(p.phases[1].tasks[1].title,'Manual import');assert.equal(p.activeTask.name,'Run native dialog');
});
test('missing or malformed plan never fabricates mockup phases or percentages',()=>{
 assert.equal(typeof progress.parseImplementationPlan,'function');assert.equal(progress.parseImplementationPlan('nothing',{}).phases.length,0);assert.equal(progress.parseImplementationPlan('nothing',{}).percent,null);
});
