import {test,expect} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildInfoPlugin} from '../scripts/build-info';

test('each build replaces stale metadata while preserving staging source and branch',()=>{
  const root=mkdtempSync(join(tmpdir(),'dock-build-info-'));
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
  try {
    git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
    writeFileSync(join(root,'fixture'),'build');git('add','fixture');git('commit','-qm','build fixture');
    const commit=git('rev-parse','HEAD');
    writeFileSync(join(root,'build-info.json'),JSON.stringify({commit:'stale',builtAt:'old'}));
    let now='2026-10-16T00:00:00.000Z';
    const plugin=buildInfoPlugin(root,{AGENT_DOCK_BUILD_SOURCE:'source-repo',AGENT_DOCK_BUILD_BRANCH:'dev'},()=>now);
    plugin.buildStart();
    expect(JSON.parse(readFileSync(join(root,'build-info.json'),'utf8'))).toMatchObject({commit,shortCommit:commit.slice(0,7),subject:'build fixture',branch:'dev',source:'source-repo',builtAt:now});
    now='2026-10-16T01:00:00.000Z';plugin.buildStart();
    expect(JSON.parse(readFileSync(join(root,'build-info.json'),'utf8')).builtAt).toBe(now);
  } finally {rmSync(root,{recursive:true,force:true});}
});
