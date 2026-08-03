import { useEffect, useRef, useState } from 'react'

import type { ClientResponse } from '../api/types.gen'
import { ApiError, createClient, fetchClientSessions, fetchClients, updateClient } from '../lib/api'
import { formatSessionDate } from '../lib/history'
import { todayIn } from '../lib/workoutDraft'
import { TrainerShell } from './TrainerShell'

type Load = 'loading' | 'ready' | 'unreachable'

/**
 * A client's most recent `performed_on`, or null for one who has never logged anything.
 *
 * Absent from the record means still in flight. Both of the other two render something
 * definite, which is why the screen never waits on any of them.
 */
type LastSessions = Record<string, string | null>

// ui-ux.md §Trainer screens, Clients: "list + add/deactivate; per-client: last session date
// (the 'who's slacking' signal — the v1 stand-in for the deferred digest)". The trainer's
// landing screen, and the first one built.
//
// ── The last-session date, and what it costs ───────────────────────────────────────────────
// There is no roster field for it. GET /api/clients returns identity and is_active; the only
// route that knows when someone last trained is GET /api/clients/:id/sessions. So N clients is
// N requests, fired in parallel after the roster is already on screen.
//
// That is #46's shape and #46's argument, and it holds here for the same reasons: the requests
// are parallel so the wall clock is one round trip rather than N, and nothing blocks on them —
// the roster, the add form, and the deactivate controls all render from the first response, and
// each cell starts on a dash and fills in. A trainer can add a client before any of them land.
//
// The honest cost, which is not the request count:
//   * Each response is that client's *entire* session history. There is no limit parameter and
//     no summary field, so reading one date downloads every session that client has ever
//     logged. This degrades with client tenure, not with roster size — the axis nobody watches.
//     Four clients a year in is a few hundred small rows; four clients five years in is not.
//   * N queries per screen open, where one would do.
// At v1 scale (one trainer, a handful of clients, months of history) both are fine, and neither
// is worth an API change inside a web ticket. The fix when it stops being fine is one field —
// last_session_on on ClientResponse, computed as a grouped max — which deletes this entire
// effect and every request it makes. That is the moment to spend it, not before.
export function ClientsScreen() {
  const [load, setLoad] = useState<Load>('loading')
  const [clients, setClients] = useState<ClientResponse[]>([])
  const [lastSessions, setLastSessions] = useState<LastSessions>({})
  const [attempt, setAttempt] = useState(0)

  /** Clients already asked about, so a re-render never re-requests. See the effect below. */
  const requested = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    setLoad('loading')

    fetchClients()
      .then((roster) => {
        if (!cancelled) {
          setClients(roster)
          setLoad('ready')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoad('unreachable')
        }
      })

    return () => {
      cancelled = true
    }
  }, [attempt])

  // Fired once the roster is on screen, one request per client, none of them blocking anything.
  // A dropped read of decision support is not worth an error banner on a screen whose job is
  // the roster: a cell that never answers keeps its dash, which reads as "not known" and is
  // exactly true.
  useEffect(() => {
    if (load !== 'ready') {
      return
    }

    let cancelled = false
    for (const client of clients) {
      const id = client.id
      // A ref, not the state this effect writes: keying the guard on `lastSessions` would make
      // it a dependency, and the effect would re-run on every arrival to discover it has
      // nothing left to do. The set only ever grows, so a re-run costs one pass over the
      // roster.
      if (id === undefined || requested.current.has(id)) {
        continue
      }
      requested.current.add(id)

      fetchClientSessions(id)
        .then((sessions) => {
          if (!cancelled) {
            // Ordered by performed_on DESC by the endpoint, so the head is the answer.
            setLastSessions((previous) => ({
              ...previous,
              [id]: sessions[0]?.performedOn ?? null,
            }))
          }
        })
        .catch(() => {
          // Deliberately not recorded as null: null means "has never trained", which is a
          // claim, and a failed request is not evidence for it. Left absent, so the cell keeps
          // its dash rather than accusing someone of slacking on the strength of a timeout.
        })
    }

    return () => {
      cancelled = true
    }
  }, [load, clients])

  function onAdded(client: ClientResponse) {
    // Inserted and re-sorted rather than appended: the endpoint orders by display name, and a
    // new client landing at the bottom would put the roster in an order no reload reproduces.
    setClients((previous) =>
      [...previous, client].sort((left, right) =>
        (left.displayName ?? '').localeCompare(right.displayName ?? ''),
      ),
    )
  }

  function onUpdated(client: ClientResponse) {
    setClients((previous) =>
      previous.map((candidate) => (candidate.id === client.id ? client : candidate)),
    )
  }

  return (
    <TrainerShell>
      <div className="flex items-baseline justify-between gap-6">
        <h1 className="text-xl font-semibold text-ink-bold">Clients</h1>
      </div>

      {load === 'loading' ? (
        <p className="mt-8 text-base text-muted" role="status">
          Loading your clients
        </p>
      ) : load === 'unreachable' ? (
        <div className="mt-8 grid justify-items-start gap-4">
          <div className="grid gap-2">
            <h2 className="text-lg font-semibold text-ink-bold">We couldn&rsquo;t load your clients</h2>
            <p className="text-base text-muted">Check your connection and try again.</p>
          </div>
          <button
            className="text-base font-semibold text-ink underline underline-offset-4"
            onClick={() => setAttempt((previous) => previous + 1)}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {clients.length === 0 ? (
            <p className="mt-8 text-base text-muted">
              No clients yet. Add one below, then tell them to log in with their email.
            </p>
          ) : (
            <Roster clients={clients} lastSessions={lastSessions} onUpdated={onUpdated} />
          )}

          <AddClient onAdded={onAdded} />
        </>
      )}
    </TrainerShell>
  )
}

// A table, not a list of cards. The roster is five parallel facts about each of several rows,
// read by comparing down a column — which is what a table is for, and what DESIGN.md means by
// reserving cards for units that are bounded and meaningful alone. On a desktop screen the
// column of dates *is* the "who's slacking" signal; the same data as cards would be a grid of
// identical boxes, which the same doc bans by name.
function Roster({
  clients,
  lastSessions,
  onUpdated,
}: {
  clients: ClientResponse[]
  lastSessions: LastSessions
  onUpdated: (client: ClientResponse) => void
}) {
  const today = todayIn(undefined)

  return (
    <table className="mt-8 w-full border-collapse text-left">
      <caption className="sr-only">Your clients, with the date each last trained</caption>
      <thead>
        <tr className="border-b border-edge-strong">
          <th className="py-2 pr-4 text-xs font-normal text-muted" scope="col">
            Client
          </th>
          <th className="py-2 pr-4 text-xs font-normal text-muted" scope="col">
            Last session
          </th>
          <th className="py-2 pr-4 text-xs font-normal text-muted" scope="col">
            Status
          </th>
          {/* The column exists structurally so the header row and the body agree; naming it
              "Actions" would be a label for a thing the buttons already say. */}
          <th className="py-2" scope="col">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {clients.map((client) => (
          <ClientRow
            client={client}
            key={client.id}
            lastSession={client.id === undefined ? undefined : lastSessions[client.id]}
            onUpdated={onUpdated}
            today={today}
          />
        ))}
      </tbody>
    </table>
  )
}

function ClientRow({
  client,
  lastSession,
  onUpdated,
  today,
}: {
  client: ClientResponse
  lastSession: string | null | undefined
  onUpdated: (client: ClientResponse) => void
  today: string
}) {
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const active = client.isActive !== false
  const name = client.displayName ?? 'Client'

  async function setActive(isActive: boolean) {
    if (client.id === undefined || saving) {
      return
    }

    setSaving(true)
    setError(null)
    try {
      onUpdated(await updateClient(client.id, { isActive }))
      setConfirming(false)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr className="border-b border-edge align-top">
      <td className="py-3 pr-4">
        <span className="block text-base font-semibold text-ink-bold">{name}</span>
        <span className="block text-sm text-muted">{client.email}</span>
      </td>

      <td className="py-3 pr-4">
        <LastSession performedOn={lastSession} today={today} />
      </td>

      <td className="py-3 pr-4 text-sm text-ink">
        {active ? 'Active' : 'Deactivated'}
      </td>

      <td className="py-3">
        {confirming ? (
          // Inline, replacing the control that raised it, rather than a dialog over the page:
          // DESIGN.md calls the modal the lazy first answer, and #105/#108 settled the same
          // question for the client screens. The prompt names the side effect because it is
          // the part the trainer would not predict — deactivating also switches off their
          // reminder emails, in the same transaction (#25).
          <div className="grid justify-items-start gap-2" role="group">
            <p className="text-sm text-ink-bold">
              Deactivate {name}? Their reminder emails stop too.
            </p>
            <div className="flex gap-2">
              <button
                className="rounded-sm border border-edge px-3 py-2 text-sm font-semibold text-danger disabled:text-muted"
                disabled={saving}
                onClick={() => void setActive(false)}
                type="button"
              >
                {saving ? 'Deactivating' : 'Deactivate'}
              </button>
              <button
                className="rounded-sm bg-accent px-3 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover"
                onClick={() => {
                  setConfirming(false)
                  setError(null)
                }}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            className="rounded-sm border border-edge px-3 py-2 text-sm font-semibold text-ink disabled:text-muted"
            disabled={saving}
            onClick={() => (active ? setConfirming(true) : void setActive(true))}
            type="button"
          >
            {saving ? 'Saving' : active ? `Deactivate ${name}` : `Reactivate ${name}`}
          </button>
        )}

        {error !== null && (
          <p className="mt-2 text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        {/* Reactivation is offered because the API has it and a one-way control would make a
            mis-click unrecoverable from this screen. It is deliberately not sold as an undo:
            #25 disables reminder schedules when deactivating and does not re-enable them on the
            way back, so reminders stay off until the trainer turns them on from the client's
            schedule (#51). Saying so here beats a trainer discovering it when the emails never
            resume. */}
        {!active && !saving && (
          <p className="mt-2 text-xs text-muted">Reminders stay off until you turn them back on.</p>
        )}
      </td>
    </tr>
  )
}

// The signal itself. A bare date makes the trainer do arithmetic against today to answer the
// only question they are asking, so the age leads and the date supports it.
function LastSession({
  performedOn,
  today,
}: {
  performedOn: string | null | undefined
  today: string
}) {
  if (performedOn === undefined) {
    // Still loading, or the request failed. One dash, and no claim either way.
    return <span className="text-base text-muted tabular-nums">&ndash;</span>
  }

  if (performedOn === null) {
    return <span className="text-base text-muted">No sessions yet</span>
  }

  return (
    <>
      <span className="block text-base font-semibold text-ink-bold">
        {relativeDay(performedOn, today)}
      </span>
      <span className="block text-sm text-muted tabular-nums">{formatSessionDate(performedOn)}</span>
    </>
  )
}

/**
 * "Today" / "Yesterday" / "12 days ago", from two YYYY-MM-DD calendar dates.
 *
 * Both sides are calendar dates rather than instants, so they are compared as dates: parsed
 * into UTC midnight and differenced. Letting `new Date('2026-08-01')` meet the browser's zone
 * shifts the result by a day for anyone west of Greenwich, which on this screen means a client
 * who trained today reading as yesterday.
 *
 * Known approximation: performed_on is the *client's* local date and `today` is the trainer's.
 * A trainer in Toronto looking at a client in Berlin can be a day out around midnight. Fixing
 * it would mean resolving each client's own today from their stored timezone, which is real
 * work for a signal whose whole job is "roughly how long has it been".
 */
function relativeDay(performedOn: string, today: string): string {
  const then = utcDate(performedOn)
  const now = utcDate(today)
  if (then === null || now === null) {
    return formatSessionDate(performedOn)
  }

  const days = Math.round((now - then) / 86_400_000)
  if (days <= 0) {
    return 'Today'
  }
  if (days === 1) {
    return 'Yesterday'
  }

  return `${days} days ago`
}

function utcDate(value: string): number | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return parts === null
    ? null
    : Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
}

// Behind a disclosure rather than always on screen. Adding a client happens a handful of times
// in this system's life and reading the roster happens every visit, so the roster is the
// subject of the screen and the form is a thing you go and get. Progressive, not a modal —
// DESIGN.md's preferred order.
function AddClient({ onAdded }: { onAdded: (client: ClientResponse) => void }) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [timezone, setTimezone] = useState(browserTimezone)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addedName, setAddedName] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) {
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const created = await createClient({
        email: email.trim(),
        displayName: displayName.trim(),
        timezone,
      })
      onAdded(created)
      setAddedName(created.displayName ?? email.trim())
      setEmail('')
      setDisplayName('')
    } catch (caught) {
      // The server's messages are written for a person (api.md), including the 409 for an
      // address already in use, so they are shown rather than remapped per code.
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <button
        className="mt-8 rounded-sm border border-edge px-3 py-2 text-sm font-semibold text-ink"
        onClick={() => setOpen(true)}
        type="button"
      >
        Add a client
      </button>
    )
  }

  return (
    <section className="mt-8 max-w-xl rounded-md border border-edge p-6">
      <h2 className="text-lg font-semibold text-ink-bold">Add a client</h2>

      {/* api.md is explicit that POST /api/clients sends nothing: "invite = trainer tells them
          to log in via magic link". So the screen says what did not happen, because a trainer
          who assumes an invite went out is a client who never hears from anyone. */}
      <p className="mt-1 text-sm text-muted">
        No email is sent. Tell them to log in with this address and they&rsquo;ll get a link.
      </p>

      <form className="mt-6 grid gap-4" onSubmit={onSubmit}>
        <div className="grid gap-2">
          <label className="text-sm font-semibold text-ink" htmlFor="client-name">
            Name
          </label>
          <input
            className="rounded-sm border border-edge bg-surface px-3 py-2 text-base text-ink"
            id="client-name"
            name="displayName"
            onChange={(event) => setDisplayName(event.target.value)}
            required
            value={displayName}
          />
        </div>

        <div className="grid gap-2">
          <label className="text-sm font-semibold text-ink" htmlFor="client-email">
            Email
          </label>
          <input
            autoCapitalize="none"
            className="rounded-sm border border-edge bg-surface px-3 py-2 text-base text-ink"
            id="client-email"
            name="email"
            onChange={(event) => setEmail(event.target.value)}
            required
            spellCheck={false}
            type="email"
            value={email}
          />
        </div>

        <div className="grid gap-2">
          <label className="text-sm font-semibold text-ink" htmlFor="client-timezone">
            Timezone
          </label>
          {/* A select over the platform's own IANA list, not a text field. The endpoint
              validates against TimeZoneInfo and rejects anything it does not recognise, so a
              typed "EST" is a round trip to be told no — and this value is what the reminder
              scheduler sends against, so a wrong-but-valid zone is a client emailed at 4am.
              Defaults to the trainer's own zone, which is the right guess for most rosters. */}
          <select
            className="rounded-sm border border-edge bg-surface px-3 py-2 text-base text-ink"
            id="client-timezone"
            name="timezone"
            onChange={(event) => setTimezone(event.target.value)}
            value={timezone}
          >
            {TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>

        {error !== null && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        {addedName !== null && error === null && (
          <p className="text-sm text-ink" role="status">
            {addedName} added. Tell them to log in.
          </p>
        )}

        <div className="flex gap-2">
          <button
            className="rounded-sm bg-accent px-4 py-2 text-base font-semibold text-accent-ink hover:bg-accent-hover disabled:bg-surface-sunk disabled:text-muted"
            disabled={submitting}
            type="submit"
          >
            {submitting ? 'Adding' : 'Add client'}
          </button>
          <button
            className="rounded-sm border border-edge px-4 py-2 text-base font-semibold text-ink"
            onClick={() => {
              setOpen(false)
              setError(null)
              setAddedName(null)
            }}
            type="button"
          >
            Done
          </button>
        </div>
      </form>
    </section>
  )
}

// Resolved once at module load: the list is ~400 static strings and rebuilding it per render
// would be the most expensive thing on the screen.
const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone

const TIMEZONES: string[] = (() => {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  // The browser's own zone is not guaranteed to be in the list it reports, and a select whose
  // value is not among its options renders as blank.
  return zones.includes(browserTimezone) ? zones : [browserTimezone, ...zones]
})()
