import { useEffect, useState } from 'react'
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'

import { loadSession, type Session } from './lib/api'
import { useClientSession } from './lib/session'
import { LoginScreen } from './screens/LoginScreen'
import { LogWorkoutScreen } from './screens/LogWorkoutScreen'
import { TodayScreen } from './screens/TodayScreen'
import { VerifyScreen } from './screens/VerifyScreen'

// The route table. BrowserRouter lives in main.tsx so this component can be mounted under a
// MemoryRouter in tests.
//
// Two of these routes are reached from an email, which is why they are real URLs with real
// query strings rather than app state: /verify?token= is opened cold, in whatever browser the
// mail app hands it to, often after a scanner has already touched it.
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route path="/verify" element={<VerifyScreen />} />

      {/* Everything a signed-in client can reach sits under one gate, so the session is
          resolved once per navigation and every later screen (#44 onward) inherits it. */}
      <Route element={<RequireClientSession />}>
        <Route path="/" element={<TodayRoute />} />
        <Route path="/workout" element={<LogWorkoutRoute />} />
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

  if (session.kind === 'notAClient') {
    return <TrainerPlaceholder />
  }

  return <Outlet context={{ me: session.me }} />
}

function TodayRoute() {
  // `me` arrives as a prop rather than from context inside TodayScreen, so the screen renders
  // in a test without a router around it.
  const { me } = useClientSession()
  return <TodayScreen me={me} />
}

// /api/me is client-only, so a trainer holds a valid session and still gets 404 from it. Their
// screens are epic #8; until then this says so instead of bouncing them to login as though
// their session had failed.
function TrainerPlaceholder() {
  return (
    <main className="grid min-h-dvh grid-rows-[auto_1fr] px-6 pb-10 pt-10">
      <p className="text-sm font-semibold tracking-wide text-muted">TrainerOS</p>
      <div className="mx-auto grid w-full max-w-lg content-center gap-2">
        <h1 className="text-xl font-semibold text-ink-bold">Signed in</h1>
        <p className="text-base text-muted">The trainer dashboard arrives with the trainer screens.</p>
      </div>
    </main>
  )
}

function LogWorkoutRoute() {
  // Same shape as TodayRoute: context is read here, `me` goes in as a prop, so the screen
  // renders in a test with only a router around it.
  const { me } = useClientSession()
  return <LogWorkoutScreen me={me} />
}
