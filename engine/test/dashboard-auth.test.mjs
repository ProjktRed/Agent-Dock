import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startDashboardServer} from '../src/dashboard-server.mjs';
import {DashboardState} from '../src/dashboard-state.mjs';

test('dashboard requires a per-server bearer token before reads or state changes',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'dashboard-auth-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const start=()=>startDashboardServer({stateDir:root,workspace:root,port:0});
  const dashboard=await start();t.after(()=>dashboard.close());
  const state=new DashboardState({stateDir:root});
  await state.initialize({task:{id:'auth',name:'Auth',prompt:'Test'},workspace:root,maxAttempts:1});
  for(const route of ['/api/status','/api/logs'])assert.equal((await fetch(dashboard.url+route)).status,401);
  const body=JSON.stringify({action:'pause'});
  const before=await state.readControl();
  for(const route of ['/api/control','/api/activity/clear']) {
    assert.equal((await fetch(dashboard.url+route,{method:'POST',headers:{'content-type':'application/json'},body})).status,401);
  }
  assert.deepEqual(await state.readControl(),before);
  assert.equal((await fetch(dashboard.url+'/api/status',{headers:{authorization:'Bearer wrong'}})).status,401);
  assert.equal((await fetch(dashboard.url+'/api/status?token='+dashboard.token)).status,401);
  const headers={authorization:'Bearer '+dashboard.token,'content-type':'application/json'};
  assert.equal((await fetch(dashboard.url+'/api/control',{method:'POST',headers,body})).status,200);
  assert.equal((await fetch(dashboard.url+'/api/status',{headers})).status,200);
  assert.equal(new URL(dashboard.launchUrl).hash,'#token='+dashboard.token);
  assert.equal(new URL(dashboard.launchUrl).search,'');
  const other=await start();t.after(()=>other.close());
  assert.notEqual(other.token,dashboard.token);
  assert.equal((await fetch(other.url+'/api/status',{headers})).status,401);
  const page=await fetch(dashboard.url);assert.equal(page.headers.get('referrer-policy'),'no-referrer');
  assert.ok(page.headers.get('content-security-policy'));
});
