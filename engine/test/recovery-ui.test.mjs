import test from 'node:test';import assert from 'node:assert/strict';
import {dashboardView} from '../ui/view-model.js';
test('attention is advisory, active role wins and elevation result persists in worker phase',()=>{
 const state={userAttention:true,userAttentionReason:'incorrect owner',correctionCount:3,elevateResult:{label:'Strategy revised',newStrategy:'fix owner'}};
 assert.equal(dashboardView({...state,stage:'USER_ATTENTION'}).primaryLabel,'User Attention');
 assert.equal(dashboardView({...state,stage:'elevating',elevateRunning:true}).primaryLabel,'Elevating');
 assert.equal(dashboardView({...state,stage:'BLOCKED'}).primaryLabel,'Blocked');
 assert.equal(dashboardView({...state,stage:'WAITING_FOR_CODEX'}).primaryLabel,'Waiting for Codex');
 const view=dashboardView({...state,stage:'cline-working',clineStatus:'running'});assert.equal(view.recovery.correctionCount,3);assert.equal(view.recovery.result.newStrategy,'fix owner');
});
