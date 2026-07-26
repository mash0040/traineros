import { useState } from 'react'

import { ApiError, requestMagicLink } from '../lib/api'

// ui-ux.md §Client screens, Login. One field, one button, then a state that tells the client
// to go look at their inbox.
//
// The security-shaped requirement lives in `sent`: POST /api/auth/magic-link answers 202 for
// every address, existing or not (api.md #20), and this screen must not add a distinction the
// API refused to make. There is deliberately no branch here on anything but "did the request
// itself fail" — no "account not found", no different copy per outcome. A future contributor
// adding one would turn a 202 into an account-existence oracle.
export function LoginScreen() {
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const address = email.trim()
    if (address === '' || submitting) {
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      await requestMagicLink(address)
      setSentTo(address)
    } catch (caught) {
      // Rate limiting and outages are the only failures reachable here, and both are
      // independent of whether the address exists, so surfacing them leaks nothing.
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="grid min-h-dvh grid-rows-[auto_1fr] px-6 pb-10 pt-10">
      <p className="text-sm font-semibold tracking-wide text-muted">TrainerOS</p>

      {/* content-end puts the form in the thumb zone on a phone (DESIGN.md §Thumb-reach);
          centered from sm: up, where reach stops mattering and bottom-anchored looks broken. */}
      <div className="mx-auto grid w-full max-w-[26rem] content-end gap-10 sm:content-center">
        {sentTo === null ? (
          <>
            <div className="grid gap-2">
              <h1 className="text-xl font-semibold text-ink-bold">Log in</h1>
              <p className="text-base text-muted">
                We&rsquo;ll email you a link. There&rsquo;s no password to remember.
              </p>
            </div>

            <form className="grid gap-6" onSubmit={onSubmit} noValidate={false}>
              <div className="grid gap-2">
                <label className="text-sm font-semibold text-ink" htmlFor="email">
                  Email
                </label>
                <input
                  className="min-h-[var(--tap-min)] rounded-sm border border-edge bg-surface px-3 text-base text-ink placeholder:text-muted"
                  id="email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  aria-describedby={error === null ? undefined : 'email-error'}
                />
                {error !== null && (
                  <p className="text-sm text-danger" id="email-error" role="alert">
                    {error}
                  </p>
                )}
              </div>

              {/* Disable-on-tap per ui-ux.md §Gym-floor constraints: the POST is rate-limited
                  per address, so a double tap costs the client one of three attempts. */}
              <button
                className="min-h-[var(--tap-min)] rounded-md bg-accent px-4 text-base font-semibold text-accent-ink hover:bg-accent-hover disabled:bg-surface-sunk disabled:text-muted"
                type="submit"
                disabled={submitting}
              >
                {submitting ? 'Sending' : 'Email me a link'}
              </button>
            </form>
          </>
        ) : (
          <div className="grid gap-6">
            <div className="grid gap-2">
              <h1 className="text-xl font-semibold text-ink-bold">Check your email</h1>
              {/* "If ... has an account" is the whole point: true for both outcomes, and the
                  only phrasing that stays honest without confirming the address exists. */}
              <p className="text-base text-ink">
                If <span className="font-semibold text-ink-bold">{sentTo}</span> has an account, a link is on
                its way.
              </p>
              <p className="text-sm text-muted">
                It expires in 15 minutes and can only be used once.
              </p>
            </div>

            <button
              className="min-h-[var(--tap-min)] justify-self-start text-base font-semibold text-ink underline underline-offset-4"
              type="button"
              onClick={() => {
                setSentTo(null)
                setError(null)
              }}
            >
              Use a different address
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
