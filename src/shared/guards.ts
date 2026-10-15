import type { ContextSnapshot } from './types';
import { sameContext } from './validation';
/** A late response cannot cross navigation, login, conversation or draft boundaries. */
export function mayAcceptResponse(request:ContextSnapshot,current:ContextSnapshot,requestNavigation:number,currentNavigation:number,responseNavigation:number,responseAuth:number):boolean {
  return requestNavigation===currentNavigation && responseNavigation===currentNavigation && responseAuth===current.authGeneration && sameContext(request,current);
}
