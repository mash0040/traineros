import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { ApiError, checkPauseLink, pauseReminders } from '../lib/api'

// The same five-way split the verify screen draws, for the same reasons, plus the terminal
// state this flow ends in. 'unreachable' is not 'invalid': one means the link is spent, the
// other means we could not ask. Collapsing them tells a client on gym wifi that her pause link
// is dead, and there is no way to request a replacement — the next one arrives with the next
// reminder email, which is exactly the email she is trying to stop.
type Status = 'checking' | 'valid' | 'invalid' | 'unreachable' | 'pausing' | 'paused'

// ui-ux.md §Client screens, Pause reminders. The page the footer link in every reminder email
// lands on (ReminderWorker: "Pause these reminders: {home}/pause?token=…").
//
// ── Why this is two steps ──────────────────────────────────────────────────────────────────
// notifications.md resolved question 2, and the whole reason the page exists rather than the
// link just doing the thing: email security scanners and link prefetchers issue GETs to footer
// links before the recipient ever opens the message. A one-click GET that mutated state would
// silently pause reminders for every client behind a scanning mail provider — and they would
// never find out, because the symptom is email that stops arriving. So the GET on mount only
// asks whether the link is good, and the button she presses is the only thing that writes.
// #40 enforces the same split server-side; this screen must not be the place it leaks.
//
// ── Unauthenticated by design ──────────────────────────────────────────────────────────────
// The route sits outside the session gate. The signed token is the entire authorization, and
// it authorizes exactly one thing: disabling one schedule. Requiring a session would break the
// flow for the client most likely to use it — someone who has not opened the app in weeks and
// is being reminded about it daily.
export function PauseScreen() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''

  const [status, setStatus] = useState<Status>('checking')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    if (token === '') {
      // No request worth making, and no oracle offered to a link with the token stripped off.
      setStatus('invalid')
      return
    }

    setStatus('checking')

    // GET only. If this ever becomes a POST, the prefetch problem comes straight back and
    // arrives silently.
    checkPauseLink(token)
      .then((valid) => {
        if (!cancelled) {
          setStatus(valid ? 'valid' : 'invalid')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('unreachable')
        }
      })

    return () => {
      cancelled = true
    }
  }, [token, attempt])

  async function onPause() {
    setStatus('pausing')
    setError(null)

    try {
      await pauseReminders(token)
      setStatus('paused')
    } catch (caught) {
      // #40 makes every rejection an indistinguishable 401, so a failure here means the token
      // stopped working between the check and the press: expired in the meantime, or the
      // schedule was deleted.
      if (caught instanceof ApiError && caught.isUnauthenticated) {
        setStatus('invalid')
        return
      }

      // Anything else — a dropped connection above all — leaves her on the confirmation with
      // the button still live. Nothing was paused, and the message says so rather than
      // implying the link is finished.
      setStatus('valid')
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.')
    }
  }

  return (
    <main className="grid min-h-dvh grid-rows-[auto_1fr] px-6 pb-10 pt-10">
      <p className="text-sm font-semibold tracking-wide text-muted">TrainerOS</p>

      <div className="mx-auto grid w-full max-w-[26rem] content-end gap-10 sm:content-center">
        {status === 'checking' ? (
          // No spinner, same as verify: the check is one request and a spinner for 80ms is
          // noise. Plain text, announced for screen readers.
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
              onClick={() => setAttempt((previous) => previous + 1)}
              type="button"
            >
              Try again
            </button>
          </>
        ) : status === 'invalid' ? (
          <div className="grid gap-2">
            <h1 className="text-xl font-semibold text-ink-bold">This link no longer works</h1>
            {/* Forged, expired, and schedule-since-deleted are one answer from the API by
                design (#40), so the copy covers the causes without claiming which. There is no
                action button: she cannot request a pause link, they only arrive with reminders.
                Naming where a working one comes from is more use than a control that would
                have to lead somewhere unrelated. */}
            <p className="text-base text-muted">
              Pause links expire after 30 days. The newest reminder email always has one that
              works, or your trainer can turn reminders off for you.
            </p>
          </div>
        ) : status === 'paused' ? (
          <div className="grid gap-2">
            <h1 className="text-xl font-semibold text-ink-bold">Reminders paused</h1>
            {/* Worded to be true whether or not this press is what flipped the bit. The API
                cannot tell us: the POST is a plain update that reports success on an
                already-paused schedule (#40 keeps it a no-op precisely so a replayed request
                changes nothing), and the GET only answers whether the schedule exists. So
                "we've paused them" would be a guess, while this is a statement about the state
                she is now in, which is right either way.

                It also says who can undo it. notifications.md makes re-enabling the trainer's
                job through the dashboard rather than a second token flow, so a client left to
                infer that would be stuck. */}
            <p className="text-base text-muted">
              You won&rsquo;t get reminder emails for your program. Ask your trainer when you
              want them back on.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-2">
              <h1 className="text-xl font-semibold text-ink-bold">Pause reminder emails?</h1>
              <p className="text-base text-muted">
                Nothing is paused until you tap. Your trainer can turn reminders back on.
              </p>
              {error !== null && (
                <p className="text-sm text-danger" role="alert">
                  {error}
                </p>
              )}
            </div>

            {/* The only thing in the app that writes this change, and it is a press. Amber
                because DESIGN.md spends the accent on the thing to tap and this screen has
                exactly one; not --danger, because pausing your own email is a preference the
                trainer can reverse, not a destructive act. */}
            <button
              className="min-h-[var(--tap-min)] rounded-md bg-accent px-4 text-base font-semibold text-accent-ink hover:bg-accent-hover disabled:bg-surface-sunk disabled:text-muted"
              disabled={status === 'pausing'}
              onClick={() => void onPause()}
              type="button"
            >
              {status === 'pausing' ? 'Pausing' : 'Pause reminders'}
            </button>
          </>
        )}
      </div>
    </main>
  )
}
