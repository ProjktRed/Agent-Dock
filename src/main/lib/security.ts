import type {Session,WebContents} from 'electron';

export function assertSafeLaunch(packaged:boolean,argv:string[]):void {
  if(!packaged)return;
  if(argv.some(arg=>/^--(?:inspect|remote-debugging|js-flags)(?:[-=]|$)/i.test(arg.replaceAll('_','-')))) {
    throw new Error('Debugging and inspector switches are disabled in packaged Agent Dock.');
  }
}

export function hardenSession(session:Pick<Session,'setPermissionCheckHandler'|'setPermissionRequestHandler'|'setDevicePermissionHandler'>):void {
  session.setPermissionCheckHandler(()=>false);
  session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.setDevicePermissionHandler(()=>false);
}

export function hardenWebContents(contents:Pick<WebContents,'on'>):void {
  contents.on('will-attach-webview',event=>event.preventDefault());
}
