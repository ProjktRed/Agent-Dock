import {readdirSync, realpathSync, statSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The native form expands Windows short (8.3) names such as C:\Users\RUNNER~1, so the paths given to
// Codex match its own canonical paths; the JavaScript form leaves them short.
const canonicalPath = (p) => realpathSync.native(p);

export const claudeSkillArgs = ['--disable-slash-commands'];
const UNREADABLE = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP']);

// Codex has per-skill disable rules, not a universal skills=false switch.
// Snapshot the on-disk skills before EACH launch; never relocate CODEX_HOME/auth
// or edit the user's configuration. Include canonical paths for linked skills.
export function codexSkillArgs({workspace, env = process.env}) {
  const homes = [...new Set([env.HOME, env.USERPROFILE, env.HOMEDRIVE && env.HOMEPATH && env.HOMEDRIVE + env.HOMEPATH].filter(Boolean))];
  if (!homes.length) homes.push(os.homedir());
  const codexHomes = env.CODEX_HOME ? [env.CODEX_HOME] : homes.map(home => path.join(home, '.codex'));
  const roots = codexHomes.flatMap(home => [path.join(home, 'skills'), path.join(home, 'plugins', 'cache')]);
  const folders = ['.agents', '.claude', '.codex', '.opencode', '.cline'];
  roots.push(...homes.flatMap(home => folders.map(dir => path.join(home, dir, 'skills'))));
  for (let dir = path.resolve(workspace);; dir = path.dirname(dir)) {
    roots.push(...folders.map(folder => path.join(dir, folder, 'skills')));
    if (path.dirname(dir) === dir) break;
  }
  const visited = new Set(), skills = new Set();
  function scan(dir) {
    // Codex cannot load a skill it cannot read either: skip missing, broken or unreadable entries.
    let canonical, entries;
    try { canonical = canonicalPath(dir); }
    catch (error) { if (UNREADABLE.has(error.code)) return; throw error; }
    if (visited.has(canonical)) return;
    visited.add(canonical);
    try { entries = readdirSync(canonical, {withFileTypes:true}); }
    catch (error) { if (UNREADABLE.has(error.code)) return; throw error; }
    for (const entry of entries) {
      const file = path.join(canonical, entry.name);
      let stat;
      try { stat = entry.isSymbolicLink() ? statSync(file) : entry; }
      catch (error) { if (UNREADABLE.has(error.code)) continue; throw error; }
      if (stat.isDirectory()) scan(file);
      else if (entry.name === 'SKILL.md' && stat.isFile()) skills.add(canonicalPath(file));
    }
  }
  for (const root of roots) scan(root);
  const rules = [...skills].sort().map(file => `{path=${JSON.stringify(file)},enabled=false}`).join(',');
  return ['-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false',
    '-c', `skills.config=[${rules}]`];
}

// Cline's supported disabledTools setting removes its skill loader. Use a
// disposable settings overlay even when the editing guard is off. Preserve
// unrelated settings and leave the interactive config and provider auth alone.
export async function clineSkillEnv(env, {dataDir, configDir} = {}) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const source = env.CLINE_GLOBAL_SETTINGS_PATH || path.join(dataDir || env.CLINE_DATA_DIR ||
    path.join(configDir || env.CLINE_DIR || path.join(home, '.cline'), 'data'), 'settings', 'global-settings.json');
  let settings = {};
  try { settings = JSON.parse(await readFile(source, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (settings.disabledTools?.includes('skills')) return {env:{...env, CLINE_GLOBAL_SETTINGS_PATH:source}, cleanup:async()=>{}};
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-dock-no-skills-'));
  try {
    const file = path.join(dir, 'global-settings.json');
    await writeFile(file, JSON.stringify({...settings, disabledTools:[...new Set([...(settings.disabledTools ?? []), 'skills'])]}), {mode:0o600});
    return {env:{...env, CLINE_GLOBAL_SETTINGS_PATH:file}, cleanup:() => rm(dir, {recursive:true, force:true})};
  } catch (error) { await rm(dir, {recursive:true, force:true}); throw error; }
}
