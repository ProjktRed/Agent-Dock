/** Token stays in this tab; fragments are never sent in HTTP requests or referrers. */
export function createAuthenticatedFetch(browser) {
  const params=new URLSearchParams(browser.location.hash.slice(1));
  let token=params.get('token');
  if(token) {
    browser.history.replaceState(null,'',browser.location.pathname+browser.location.search);
    try{browser.sessionStorage.setItem('agent-dock-dashboard-token',token);}catch{}
  } else try{token=browser.sessionStorage.getItem('agent-dock-dashboard-token');}catch{}
  return (url,options={})=>{
    const target=new URL(url,browser.location.href);
    if(target.origin!==browser.location.origin)throw Error('Dashboard requests must be same-origin');
    const headers=new Headers(options.headers);
    if(token)headers.set('authorization','Bearer '+token);
    return browser.fetch(url,{...options,headers,redirect:'error'});
  };
}
