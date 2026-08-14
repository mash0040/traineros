import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { ApiError, checkMagicLink, consumeMagicLink } from '../lib/api'
import { Message } from './Message'

// 'unreachable' is not the same as 'invalid' and the difference matters: one means the token
// is spent, the other means we could not ask. Collapsing them tells a client with flaky gym
// wifi that their link expired, and sends them off to request a replacement that will hit the
// same network. Every screen after this one inherits the distinction.
type Status = 'checking' | 'valid' | 'invalid' | 'unreachable' | 'consuming'

// api.md §GET /api/auth/verify: this page validates on load and consumes on press, never the
// other way round. Mail scanners and link prefetchers GET the URL in this email before the
// client ever taps it, so a page that consumed on mount would hand every scanned inbox a
// dead link. The button is the only thing that spends the token.
export function VerifyScreen() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') ?? ''

  const [status, setStatus] = useState<Status>('checking')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    if (token === '') {
      setStatus('invalid')
      return
    }

    setStatus('checking')

    // GET only. If this ever becomes a POST, the prefetch problem comes straight back.
    checkMagicLink(token)
      .then((valid) => {
        if (!cancelled) {
          setStatus(valid ? 'valid' : 'invalid')
        }
      })
      .catch(() => {
        // The request never got an answer. The token is very likely fine; say so, and offer
        // to ask again rather than declaring the link dead.
        if (!cancelled) {
          setStatus('unreachable')
        }
      })

    return () => {
      cancelled = true
    }
  }, [token, attempt])

  async function onContinue() {
    setStatus('consuming')
    setError(null)

    try {
      await consumeMagicLink(token)
      // The cookie is set by the response; auth state is re-read from the server on the next
      // screen, never assumed from this success.
      navigate('/', { replace: true })
    } catch (caught) {
      // #21 makes every rejection an indistinguishable 401, so a failure here means the token
      // died between the check and the press: used elsewhere, or expired in the meantime.
      if (caught instanceof ApiError && caught.isUnauthenticated) {
        setStatus('invalid')
        return
      }

      setStatus('valid')
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.')
    }
  }

  return (
    <main className="grid min-h-dvh grid-rows-[auto_1fr] px-6 pb-10 pt-10">
      <p className="text-sm font-semibold tracking-wide text-muted">TrainerOS</p>

      <div className="mx-auto grid w-full max-w-lg content-end gap-10 sm:content-center">
        {status === 'checking' ? (
          // No spinner: the check is one request against a local API and a spinner for
          // 80ms is noise. Plain text, announced for screen readers.
          <p className="text-base text-muted" role="status">
            Checking your link
          </p>
        ) : status === 'unreachable' ? (
          <>
            <div className="grid gap-2">
              <h1 className="text-xl font-semibold text-ink-bold">We couldn&rsquo;t check your link</h1>
              <p className="text-base text-muted">
                Your link is probably fine. Check your connection and try again.
              </p>
            </div>

            <button
              className="min-h-[var(--tap-min)] rounded-md bg-accent px-4 text-base font-semibold text-accent-ink hover:bg-accent-hover"
              type="button"
              onClick={() => setAttempt((previous) => previous + 1)}
            >
              Try again
            </button>
          </>
        ) : status === 'invalid' ? (
          <>
            <div className="grid gap-2">
              <h1 className="text-xl font-semibold text-ink-bold">This link no longer works</h1>
              {/* Expired, already used, and never-valid are one answer from the API by
                  design, so the copy explains both causes without claiming which. */}
              <p className="text-base text-muted">
                Links expire after 15 minutes and can only be used once.
              </p>
            </div>

            <Link
              className="grid min-h-[var(--tap-min)] place-items-center rounded-md bg-accent px-4 text-base font-semibold text-accent-ink hover:bg-accent-hover"
              to="/login"
            >
              Get a new link
            </Link>
          </>
        ) : (
          <>
            <div className="grid gap-2">
              <h1 className="text-xl font-semibold text-ink-bold">Welcome back</h1>
              <p className="text-base text-muted">Your link checks out. One tap to finish.</p>
              {error !== null && (
                <Message id="verify-error" tone="failure">
                  {error}
                </Message>
              )}
            </div>

            {/* aria-describedby, per DESIGN.md §Messages (#138): role="alert" announces that
                something went wrong, and nothing connected it to the control it was about.
                Someone who tabs to this button after the announcement has passed hears
                "Continue" and no reason it did not work the first time. */}
            <button
              aria-describedby={error === null ? undefined : 'verify-error'}
              className="min-h-[var(--tap-min)] rounded-md bg-accent px-4 text-base font-semibold text-accent-ink hover:bg-accent-hover disabled:bg-surface-sunk disabled:text-muted"
              type="button"
              onClick={onContinue}
              disabled={status === 'consuming'}
            >
              {status === 'consuming' ? 'Signing in' : 'Continue'}
            </button>
          </>
        )}
      </div>
    </main>
  )
}
