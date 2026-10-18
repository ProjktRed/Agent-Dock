const path = require('node:path');
const {flipFuses,FuseVersion,FuseV1Options} = require('@electron/fuses');

// electron-builder 25 has no electronFuses option. afterPack runs before code signing.
module.exports = async function hardenElectron(context) {
  const name=context.packager.appInfo.productFilename;
  const binary=context.electronPlatformName==='darwin'
    ? path.join(context.appOutDir,name+'.app')
    : path.join(context.appOutDir,context.electronPlatformName==='win32'?name+'.exe':context.packager.executableName);
  await flipFuses(binary,{
    version:FuseVersion.V1,
    // Engine and CLI hook subprocesses use Electron's bundled Node runtime.
    [FuseV1Options.RunAsNode]:true,
    [FuseV1Options.EnableCookieEncryption]:true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:false,
    [FuseV1Options.EnableNodeCliInspectArguments]:false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:true,
    [FuseV1Options.OnlyLoadAppFromAsar]:true,
  });
};
