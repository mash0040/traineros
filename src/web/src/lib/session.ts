import { useOutletContext } from 'react-router-dom'

import type { MeResponse } from '../api/types.gen'

/**
 * What the session gate hands to every screen rendered inside it.
 *
 * `onMeChanged` exists for one write (#99): the log screen's unit toggle PATCHes /api/me and
 * gets the whole row back, and every weight on screen has to re-render from it. Handing the
 * screen a setter beats a refetch — the response *is* the new state, and a second GET would be
 * a round trip to learn what the first one already said.
 */
export type ClientSession = { me: MeResponse; onMeChanged: (me: MeResponse) => void }

// Its own module rather than an export from App.tsx: a file that exports both components and
// a hook loses fast refresh, and every screen from #44 onward imports this.
export function useClientSession(): ClientSession {
  return useOutletContext<ClientSession>()
}
