import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const config=process.argv[process.argv.indexOf('--config')+1];
const settingsPath=process.env.CLINE_GLOBAL_SETTINGS_PATH;
const settings=JSON.parse(await readFile(settingsPath,'utf8'));
const policyPath=path.join(config,'../policy.json');
const policy=JSON.parse(await readFile(policyPath,'utf8'));policy.runtimeReady=true;
await writeFile(policyPath,JSON.stringify(policy));
console.log(JSON.stringify({type:'run_result',finishReason:'completed',settingsPath,disabledTools:settings.disabledTools}));
