import {runHook} from './guard/hook-runner.mjs';
import claude from './guard/adapters/claude.mjs';
const [policyPath,logPath]=process.argv.slice(2);
const result=await runHook(claude,{policyPath,logPath});
if(result.stdout)process.stdout.write(result.stdout);
process.exit(result.exitCode);
