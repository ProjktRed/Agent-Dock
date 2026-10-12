import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {selectKnowledge,recordVerifiedIssue} from '../src/worker-knowledge.mjs';
test('knowledge only records independently verified reusable fixes and selects bounded relevant entries',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'knowledge-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'LOCAL_WORKER_ISSUES.md');
 const issue={title:'Windows launcher',subsystem:'codex windows',symptoms:'spawn codex ENOENT',cause:'cmd resolution',fix:'direct exe',verification:'launcher tests passed',nextTime:'resolve executable',avoid:'literal spawn',reusable:true,causeEstablished:true,fixImplemented:true};
 await assert.rejects(()=>recordVerifiedIssue(file,issue,{role:'worker',passed:true}),/independent/);
 await assert.rejects(()=>recordVerifiedIssue(file,issue,{role:'QA',passed:false}),/verified/);
 await recordVerifiedIssue(file,issue,{role:'QA',passed:true});await recordVerifiedIssue(file,issue,{role:'Assessment',passed:true});
 assert.equal((await readFile(file,'utf8')).match(/## Windows launcher/g).length,1);
 assert.match(await selectKnowledge(file,'spawn codex ENOENT'),/KNOWN VERIFIED ISSUE/);
 assert.equal(await selectKnowledge(file,'CSS card colors'),'');
});
