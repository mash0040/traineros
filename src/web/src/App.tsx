import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'

import { loadSession, type Session } from './lib/api'
import { LoginScreen } from './screens/LoginScreen'
import { VerifyScreen } from './screens/VerifyScreen'

// The route table. BrowserRouter lives in main.tsx so this component can be mounted under a
// MemoryRouter in tests.
//
// Two of these three routes are reached from an email, which is why they are real URLs with
// real query strings rather than app state: /verify?token= is opened cold, in whatever
// browser the mail app hands it to, often after a scanner has already touched it.
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route path="/verify" element={<VerifyScreen />} />
      <Route path="/" element={<RequireClientSession />} />
      {/* Unknown paths go home, and home decides whether that means the app or the login
          screen. Keeps the "where do I send this person" logic in exactly one place. */}
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  )
}

// The session gate every authenticated screen will sit behind. It asks the server on every
// mount because that is the only way to know: the cookie is httpOnly and unreadable here,
// and a revoked session must stop working immediately rather than when a cached flag expires.
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
    // Nothing rendered during the check. A skeleton here would flash on every load of a
    // screen that is usually one local request away from real content (ui-ux.md reserves
    // skeletons for Today and History, where the payload is bigger).
    return null
  }

  if (session.kind === 'anonymous') {
    return <Navigate replace to="/login" />
  }

  return <SignedIn session={session} />
}

// Placeholder for the Today screen (#43), which owns this route. It exists now because a
// login flow with nowhere to land cannot be verified end-to-end: reaching this text means the
// httpOnly cookie survived the redirect and the server recognised it.
function SignedIn({ session }: { session: Session }) {
  // No narrowing needed: MeResponse is a generated type now that the endpoint declares
  // .Produces<MeResponse>(). It was `unknown` until the OpenAPI document described it.
  const displayName = session.kind === 'client' ? (session.me.displayName ?? null) : null

  return (
    <main className="grid min-h-dvh grid-rows-[auto_1fr] px-6 pb-10 pt-10">
      <p className="text-sm font-semibold tracking-wide text-muted">TrainerOS</p>

      <div className="mx-auto grid w-full max-w-[26rem] content-center gap-2">
        <h1 className="text-xl font-semibold text-ink-bold">
          {displayName === null ? 'Signed in' : `Signed in as ${displayName}`}
        </h1>
        <p className="text-base text-muted">
          {session.kind === 'notAClient'
            ? 'The trainer dashboard arrives with the trainer screens.'
            : 'Today lands here next.'}
        </p>
      </div>
    </main>
  )
}
