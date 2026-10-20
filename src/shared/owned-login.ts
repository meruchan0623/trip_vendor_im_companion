/** Display-only loopback capability; never carries account credentials. */
export interface LoginPopover {id:string;url:string}
export const isLoginPopoverId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function ownedLoginURL(value:string):URL {
  const url=new URL(value);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash||!/^\/auth\/[a-f0-9]{64}$/.test(url.pathname)||url.href!==value)throw new Error('INVALID_LOGIN_URL');
  return url;
}
