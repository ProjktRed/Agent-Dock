import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {useWebAccess,codexWebSearchArgs} from '../src/web-access.mjs';
import {decide} from '../src/guard/decide.mjs';
import {definitelyRefused} from '../src/guard/ask.mjs';
import claude,{claudeImplementationTools} from '../src/guard/adapters/claude.mjs';
import {installProtection} from '../src/guard/install-protection.mjs';

test('web access off: Claude Code has no web tools and the guard refuses them outright; Codex search is off',async t=>{
 t.after(()=>useWebAccess(false));
 useWebAccess(false);
 const tools=claudeImplementationTools({task:{allowedPaths:['a.js'],qaCommand:'npm test'},toolGuard:true});
 assert.ok(tools.disallowed.includes('WebSearch')&&tools.disallowed.includes('WebFetch'));
 assert.ok(!tools.allowed.includes('WebSearch'));
 const action=claude.toAction({tool_name:'WebFetch',tool_input:{url:'https://example.com'}});
 assert.equal(action.kind,'web');
 assert.equal(decide({workspace:os.tmpdir(),protectedPaths:['.git/'],webAccess:false},action,{adapter:claude}).effect,'stop');
 assert.equal(definitelyRefused({workspace:os.tmpdir()},action),true,'never put to you: the setting decides');
 assert.deepEqual(codexWebSearchArgs(false),['-c','web_search="disabled"']);
});

test('web access on: research roles search and fetch web addresses; QA never does',async t=>{
 t.after(()=>useWebAccess(false));
 useWebAccess(true);
 const tools=claudeImplementationTools({task:{allowedPaths:['a.js'],qaCommand:'npm test'},toolGuard:true});
 assert.ok(tools.allowed.includes('WebSearch')&&tools.allowed.includes('WebFetch'));
 assert.ok(!tools.disallowed.includes('WebFetch'));
 const policy={workspace:os.tmpdir(),protectedPaths:['.git/'],webAccess:true};
 assert.equal(decide(policy,claude.toAction({tool_name:'WebSearch',tool_input:{query:'rust workspace layout'}}),{adapter:claude}).effect,'allow');
 assert.equal(decide(policy,claude.toAction({tool_name:'WebFetch',tool_input:{url:'https://doc.rust-lang.org/cargo/'}}),{adapter:claude}).effect,'allow');
 assert.equal(decide(policy,claude.toAction({tool_name:'WebFetch',tool_input:{url:'file:///C:/Users/x/.ssh/id_ed25519'}}),{adapter:claude}).effect,'stop','web addresses only');
 const dir=await mkdtemp(path.join(os.tmpdir(),'web-inv-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const workspace=await mkdtemp(path.join(os.tmpdir(),'web-ws-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
 const research=await installProtection({cli:'codex',workspace,stateDir:dir,invocation:dir});
 assert.equal(research.join(' ').includes('web_search="live"'),true);
 assert.equal(JSON.parse(await readFile(path.join(dir,'scope-policy.json'),'utf8')).webAccess,true);
 const qa=await installProtection({cli:'codex',workspace,stateDir:dir,invocation:dir,allowGitCommit:true});
 assert.equal(qa.join(' ').includes('web_search="disabled"'),true,'QA verifies; it does not research');
 assert.equal(JSON.parse(await readFile(path.join(dir,'scope-policy.json'),'utf8')).webAccess,false);
});
