import assert from 'node:assert/strict';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {getCurrentFuseWire,FuseV1Options} from '@electron/fuses';

const executable=path.resolve(process.argv[2]);
const wire=await getCurrentFuseWire(executable);
for(const option of [FuseV1Options.EnableNodeOptionsEnvironmentVariable,FuseV1Options.EnableNodeCliInspectArguments,FuseV1Options.GrantFileProtocolExtraPrivileges])assert.equal(wire[option],48);
for(const option of [FuseV1Options.RunAsNode,FuseV1Options.EnableCookieEncryption,FuseV1Options.EnableEmbeddedAsarIntegrityValidation,FuseV1Options.OnlyLoadAppFromAsar])assert.equal(wire[option],49);
const exec=promisify(execFile);
const runtime=await exec(executable,['--version'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,timeout:10000});
assert.match(runtime.stdout,/^v\d+\./);
const appEnv={...process.env};delete appEnv.ELECTRON_RUN_AS_NODE;
for(const flag of ['--remote-debugging-port=0','--remote-debugging-pipe','--inspect=0']) {
  await assert.rejects(exec(executable,[flag],{env:appEnv,windowsHide:true,timeout:10000}),error=>{
    assert.equal(error.code,64,`${flag}: ${error.message}`);return true;
  });
}
console.log('Packaged fuses, bundled Node runtime and debug-switch rejection passed.');
