import { useOutletContext } from 'react-router-dom'

import type { MeResponse } from '../api/types.gen'

/** What the session gate hands to every screen rendered inside it. */
export type ClientSession = { me: MeResponse }

// Its own module rather than an export from App.tsx: a file that exports both components and
// a hook loses fast refresh, and every screen from #44 onward imports this.
export function useClientSession(): ClientSession {
  return useOutletContext<ClientSession>()
}
