import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {useWebAccess,codexWebSearchArgs,webAddressProblem,webAddressResolvesPrivate} from '../src/web-access.mjs';
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

test('web access on: fetches of sign-in addresses, IP addresses and local names are refused',()=>{
 const policy={workspace:os.tmpdir(),protectedPaths:['.git/'],webAccess:true};
 const fetch=url=>decide(policy,claude.toAction({tool_name:'WebFetch',tool_input:{url}}),{adapter:claude});
 for(const url of ['https://user:pw@example.com/','https://token@example.com/','http://127.0.0.1:8080/','http://2130706433/','http://0x7f.1/','http://[::1]/','http://169.254.169.254/latest/meta-data/','http://localhost:3000/','http://api.localhost/','http://LOCALHOST./','http://intranet/','http://printer.local/','http://db.internal/','https://router.home.arpa/','ftp://example.com/','not a url'])
  assert.equal(fetch(url).effect,'stop',url);
 assert.match(fetch('https://u:p@example.com/').reason,/user name or password/);
 for(const url of ['https://example.com/','https://docs.python.org/3/','http://sub.example.co.uk/path?q=1'])assert.equal(fetch(url).effect,'allow',url);
 assert.equal(webAddressProblem('https://example.com.'),null,'a trailing dot is still a site name');
});

test('web access on: a site name that resolves to this computer or a private network is refused when the hook checks it',async()=>{
 const answer=list=>async()=>list.map(address=>({address,family:address.includes(':')?6:4}));
 for(const address of ['127.0.0.1','10.1.2.3','172.20.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','fd00::1','fe80::1','::ffff:127.0.0.1'])
  assert.match(await webAddressResolvesPrivate('http://127.0.0.1.nip.io/',{lookup:answer(['93.184.215.14',address])}),/private network/,address);
 assert.equal(await webAddressResolvesPrivate('https://example.com/',{lookup:answer(['93.184.215.14','2606:2800:21f:cb07:6820:80da:af6b:8b2c'])}),null);
 assert.match(await webAddressResolvesPrivate('https://nowhere.example/',{lookup:async()=>{throw Object.assign(new Error('x'),{code:'ENOTFOUND'})}}),/does not resolve/);
 assert.match(await webAddressResolvesPrivate('https://slow.example/',{lookup:()=>new Promise(()=>{}),timeoutMs:50}),/does not resolve/);
});
