import { useEffect, useState } from 'react'
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'

import { loadSession, type Session } from './lib/api'
import { useClientSession } from './lib/session'
import { ClientDetailScreen } from './screens/ClientDetailScreen'
import { ClientsScreen } from './screens/ClientsScreen'
import { HistoryScreen } from './screens/HistoryScreen'
import { LoginScreen } from './screens/LoginScreen'
import { LogWorkoutScreen } from './screens/LogWorkoutScreen'
import { NewProgramScreen } from './screens/NewProgramScreen'
import { PauseScreen } from './screens/PauseScreen'
import { ProgramBuilderScreen } from './screens/ProgramBuilderScreen'
import { TodayScreen } from './screens/TodayScreen'
import { VerifyScreen } from './screens/VerifyScreen'

// The route table. BrowserRouter lives in main.tsx so this component can be mounted under a
// MemoryRouter in tests.
//
// Two of these routes are reached from an email, which is why they are real URLs with real
// query strings rather than app state: /verify?token= and /pause?token= are opened cold, in
// whatever browser the mail app hands them to, often after a scanner has already touched them.
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route path="/verify" element={<VerifyScreen />} />
      {/* Outside the gate, deliberately (#49). The signed token is the whole authorization,
          and the client most likely to follow this link is one who has not opened the app in
          weeks — sending her to a login screen first is how a pause link stops working. */}
      <Route path="/pause" element={<PauseScreen />} />

      {/* Everything a signed-in client can reach sits under one gate, so the session is
          resolved once per navigation and every later screen (#44 onward) inherits it. */}
      <Route element={<RequireClientSession />}>
        <Route path="/" element={<TodayRoute />} />
        <Route path="/workout" element={<LogWorkoutRoute />} />
        {/* No wrapper: History reads everything it shows from GET /api/me/history, so it needs
            nothing from the session beyond being inside the gate. */}
        <Route path="/history" element={<HistoryScreen />} />
      </Route>

      {/* The trainer's screens, behind their own gate (#50). Deliberately not under a /trainer
          prefix: a session is a trainer's or a client's and never both, so the two sets of
          paths cannot collide, and prefixing would put a segment in every trainer URL whose
          only job is to distinguish them from screens that account can never open. */}
      <Route element={<RequireTrainerSession />}>
        <Route path="/clients" element={<ClientsScreen />} />
        {/* Nested under the roster path rather than a flat /client/:id, because that is what it
            is: one row of the list, opened. #52's builder hangs off a program the same way. */}
        <Route path="/clients/:clientId" element={<ClientDetailScreen />} />

        {/* The two paths #51 already links to, now that #53 has something behind them. `new`
            is declared first for readability; React Router ranks static segments above dynamic
            ones regardless, so /programs/new can never be read as a program id. */}
        <Route path="/programs/new" element={<NewProgramScreen />} />
        <Route path="/programs/:programId" element={<ProgramBuilderScreen />} />
      </Route>

      {/* Unknown paths go home, and home decides whether that means the app or the login
          screen. Keeps the "where do I send this person" logic in exactly one place. */}
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  )
}

// The session gate. It asks the server on every mount because that is the only way to know:
// the cookie is httpOnly and unreadable here, and a revoked session must stop working
// immediately rather than when a cached flag expires.
function RequireClientSession() {
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    let cancelled = false

    loadSession()
      .then((result) => {
        if (!cancelled) {
          setSession(result)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSession({ kind: 'anonymous' })
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (session === null) {
    // Nothing rendered during the check. The screen behind this gate draws its own skeleton
    // once it knows who is asking; a second one here would flash on every navigation.
    return null
  }

  if (session.kind === 'anonymous') {
    return <Navigate replace to="/login" />
  }

  // A trainer who landed on a client path. Since #50 there is somewhere to send them, so the
  // "trainer dashboard arrives later" placeholder #42 rendered here is gone. `replace` because
  // the client URL was never theirs to go back to.
  if (session.kind === 'notAClient') {
    return <Navigate replace to="/clients" />
  }

  return <Outlet context={{ me: session.me }} />
}

// The trainer half of the same gate.
//
// What "trainer" means to the SPA, precisely: the session cookie is valid and GET /api/me
// answered 404. That route is client-only, so a 404 with a live session is the API saying
// "authenticated, not a client" — and since the auth middleware refuses sessions belonging to
// deactivated users, the only remaining role is trainer. No endpoint returns trainer identity,
// so this is inference rather than a claim the API made, which is why `loadSession` keeps
// calling the state `notAClient` and this comment does the naming instead.
function RequireTrainerSession() {
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    let cancelled = false

    loadSession()
      .then((result) => {
        if (!cancelled) {
          setSession(result)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSession({ kind: 'anonymous' })
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (session === null) {
    return null
  }

  if (session.kind === 'anonymous') {
    return <Navigate replace to="/login" />
  }

  // A client who typed a trainer URL. Not an error page: they have a perfectly good session,
  // it just is not for this. Every route behind this gate is trainer-only server-side anyway,
  // so the redirect is a courtesy on top of the real gate, never the gate itself.
  if (session.kind === 'client') {
    return <Navigate replace to="/" />
  }

  return <Outlet />
}

function TodayRoute() {
  // `me` arrives as a prop rather than from context inside TodayScreen, so the screen renders
  // in a test without a router around it.
  const { me } = useClientSession()
  return <TodayScreen me={me} />
}

function LogWorkoutRoute() {
  // Same shape as TodayRoute: context is read here, `me` goes in as a prop, so the screen
  // renders in a test with only a router around it.
  const { me } = useClientSession()
  return <LogWorkoutScreen me={me} />
}
