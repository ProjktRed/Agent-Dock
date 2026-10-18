import {describe,it,expect} from 'vitest';
import {buildEngineArgs} from '../src/main/lib/engine-args';
import {DEFAULT_SETTINGS,DEFAULT_CLIS,defaultAgents} from '../src/main/defaults';
import type {Project} from '../src/shared/types';
import * as security from '../src/main/lib/security';

describe('security launch configuration',()=>{
  it('forwards protected paths and mandatory application/state roots even with guardrails off',()=>{
    const project:Project={id:'p',name:'P',path:'C:\\work',repoUrl:null,objective:'Ship',description:'',createdAt:'',archived:false,stateDir:'C:\\dock\\state',roleOverrides:{},workflowOverrides:{}};
    const settings=structuredClone(DEFAULT_SETTINGS);settings.advanced.engineGuardrails=false;
    const plan=buildEngineArgs({project,settings,agents:defaultAgents({qa:'gpt-6.1-sol',assessment:'gpt-6.1-sol',elevate:'gpt-6-astra',reasoning:'medium'}),clis:DEFAULT_CLIS,protectedRoots:['C:\\dock\\app','C:\\dock\\data']});
    const index=plan.args.indexOf('--protected-paths');expect(index).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(plan.args[index+1])).toEqual(expect.arrayContaining(['.git/','.env*','secrets/','C:\\dock\\state','C:\\dock\\app','C:\\dock\\data']));
  });
});

describe('packaged Electron hardening',()=>{
  it('refuses debug and inspector switches only in packaged launches',()=>{
    for(const arg of ['--remote-debugging-port=9222','--remote-debugging-pipe','--inspect','--inspect-brk=9229','--inspect-port','--inspect_brk=9229']) {
      expect(()=>security.assertSafeLaunch(true,['app',arg])).toThrow(/debug|inspect/i);
      expect(()=>security.assertSafeLaunch(false,['electron',arg])).not.toThrow();
    }
    expect(()=>security.assertSafeLaunch(true,['app','--minimized'])).not.toThrow();
  });
  it('denies permission checks, permission requests and webview attachment',()=>{
    let check:Function=()=>true,request:Function=()=>{},attach:Function=()=>{};
    security.hardenSession({setPermissionCheckHandler:(fn:any)=>{check=fn;},setPermissionRequestHandler:(fn:any)=>{request=fn;},setDevicePermissionHandler:()=>{}} as any);
    expect(check(null,'camera','https://example.com')).toBe(false);
    let result=true;request(null,'media',(allowed:boolean)=>{result=allowed;});expect(result).toBe(false);
    security.hardenWebContents({on:(event:string,fn:Function)=>{if(event==='will-attach-webview')attach=fn;}} as any);
    let blocked=false;attach({preventDefault:()=>{blocked=true;}});expect(blocked).toBe(true);
  });
});
