export function dashboardFetch(dashboard,route='',options={}) {
  return fetch(dashboard.url+route,{...options,headers:{...options.headers,authorization:'Bearer '+dashboard.token}});
}
