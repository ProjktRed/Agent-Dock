import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {replaceWithRetry as rename} from './fs-retry.mjs';
import path from 'node:path';import {randomUUID} from 'node:crypto';
const header='# Local Worker Issues\n\nThis file contains verified recurring issues that may help avoid repeated debugging.\nOnly verified fixes should be recorded.\n';
async function contents(file){try{return await readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return header;throw e;}}
export async function selectKnowledge(file, context) {
  const terms=new Set(String(context).toLowerCase().match(/[a-z0-9_.-]{4,}/g)??[]);
  const entries=(await contents(file)).split(/(?=^## )/m).filter(x=>x.startsWith('## '));
  return entries.map(entry=>({entry,score:[...terms].filter(t=>entry.toLowerCase().includes(t)).length}))
    .filter(x=>x.score>=2).sort((a,b)=>b.score-a.score).slice(0,3)
    .map(x=>'KNOWN VERIFIED ISSUE\n'+x.entry.slice(0,1800)+'\nDo not rediscover this unless current evidence contradicts it.').join('\n\n');
}
export async function recordVerifiedIssue(file, issue, verification) {
  if(!['QA','Assessment'].includes(verification?.role)) throw new Error('Knowledge requires independent QA/Assessment verification');
  if(!verification.passed || !issue?.reusable || !issue.causeEstablished || !issue.fixImplemented) throw new Error('Issue must be verified, implemented and reusable');
  const fields={subsystem:'Subsystem',symptoms:'Symptoms',cause:'Cause',fix:'Verified fix',verification:'Verification',nextTime:'Do this next time',avoid:'Avoid'};
  for(const key of ['title',...Object.keys(fields)]) if(typeof issue[key]!=='string'||!issue[key].trim()||issue[key].length>1500) throw new Error('Invalid compact issue field: '+key);
  const safe=s=>s.replace(/[\r\n]+/g,' ');
  const title=safe(issue.title), entry=`## ${title}\n\n`+Object.entries(fields).map(([k,label])=>`${label}:\n- ${safe(issue[k])}\n`).join('\n')+`\nLast confirmed:\n- ${new Date().toISOString().slice(0,10)}\n`;
  const entries=(await contents(file)).split(/(?=^## )/m).filter(x=>x.startsWith('## ')&&!x.startsWith('## '+title+'\n'));
  await mkdir(path.dirname(file),{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';
  await writeFile(temporary,header+'\n'+[...entries,entry].join('\n'));await rename(temporary,file);
}
