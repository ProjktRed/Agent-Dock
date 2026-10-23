import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {hashFiles, MANIFEST_FILE} from '../src/main/lib/integrity';

export function buildInfoPlugin(repo: string, env: NodeJS.ProcessEnv = process.env, now = () => new Date().toISOString()) {
  const git = (...args: string[]) => execFileSync('git', args, {cwd:repo, encoding:'utf8', windowsHide:true, stdio:['ignore','pipe','pipe']}).trim();
  return {
    name: 'agent-dock-build-info',
    buildStart() {
      const commit = git('rev-parse','HEAD');
      let source = env.AGENT_DOCK_BUILD_SOURCE;
      if (!source) { try { source = git('remote','get-url','origin'); } catch { source = repo; } }
      const info = {
        commit, shortCommit:commit.slice(0,7), subject:git('log','-1','--format=%s'),
        committedAt:git('log','-1','--format=%cI'),
        branch:env.AGENT_DOCK_BUILD_BRANCH || git('branch','--show-current'),
        source, builtAt:now(),
      };
      writeFileSync(join(repo,'build-info.json'), `${JSON.stringify(info,null,2)}\n`);
    },
  };
}

/** Hashes of the engine files the packaged app runs from outside app.asar (src/main/lib/integrity.ts). */
export function engineManifestPlugin(repo: string) {
  return {
    name: 'agent-dock-engine-manifest',
    generateBundle(this: { emitFile(file: { type: 'asset'; fileName: string; source: string }): void }) {
      this.emitFile({ type: 'asset', fileName: MANIFEST_FILE, source: `${JSON.stringify(hashFiles(repo), null, 2)}\n` });
    },
  };
}
