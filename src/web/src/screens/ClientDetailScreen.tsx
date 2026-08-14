import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import type { ClientResponse, ClientSessionResponse, ProgramResponse, ScheduleResponse } from '../api/types.gen'
import {
  createClientSchedule,
  fetchClientSchedule,
  fetchClientSessions,
  fetchClients,
  fetchPrograms,
  updateSchedule,
} from '../lib/api'
import { messageFor } from '../lib/apiMessages'
import { formatSessionDate } from '../lib/history'
import { DAY_ABBREVIATIONS, describeDays, toApiTime, toInputTime } from '../lib/scheduleTime'
import { useBlockMessage } from './blockMessage'
import { Message } from './Message'
import { RecordLink } from './RecordLink'
import { TrainerShell } from './TrainerShell'
import {
  trainerField,
  trainerLink,
  trainerPrimary,
  trainerRecordRow,
  trainerSecondary,
} from './trainerControls'

type Load = 'loading' | 'ready' | 'missing' | 'unreachable'

type Detail = {
  client: ClientResponse
  programs: ProgramResponse[]
  sessions: ClientSessionResponse[]
  schedule: ScheduleResponse | null
}

// ui-ux.md §Trainer screens, Client detail: "their program (edit entry point), their history,
// reminder schedule (time, days, enabled)". Reached by tapping a client on the roster (#50).
//
// ── Four reads, one of which is a whole roster ─────────────────────────────────────────────
// There is no GET /api/clients/:id. The roster route is the only one that returns a client, so
// identifying the one this screen is about means fetching all of them and finding it. That is
// also the ownership check: a client id belonging to another trainer is simply absent from the
// list, which is the same answer the API would give and needs no separate request. At v1 scale
// the whole roster is smaller than a dedicated endpoint's response headers.
//
// Same shape for programs: no per-client programs route, so GET /api/programs is filtered by
// clientId here. Both are worth a field or a route only when a trainer has enough clients for
// the difference to be visible, which is not v1.
//
// ── What "their history" can be on this screen ─────────────────────────────────────────────
// GET /api/clients/:id/sessions returns sessions, not sets: date, program day, and the client's
// note. There is no trainer-side route to a session's logged sets — GET /api/me/history is
// client-scoped — so this is session-level by construction rather than by choice. The note is
// the part with the most in it anyway (database.md calls it the v1 substitute for messaging).
export function ClientDetailScreen() {
  const { clientId = '' } = useParams()

  const [load, setLoad] = useState<Load>('loading')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoad('loading')

    // Fired together rather than in sequence: none of the four depends on another's answer,
    // and serialised they would be four round trips before anything renders.
    Promise.all([
      fetchClients(),
      fetchPrograms(),
      fetchClientSessions(clientId),
      fetchClientSchedule(clientId),
    ])
      .then(([roster, programs, sessions, schedule]) => {
        if (cancelled) {
          return
        }

        const client = roster.find((candidate) => candidate.id === clientId)
        if (client === undefined) {
          // Not this trainer's client, or a URL that never named one. Same answer either way,
          // which is the same non-answer the API gives — nothing here tells the difference.
          setLoad('missing')
          return
        }

        setDetail({
          client,
          programs: programs.filter((program) => program.clientId === clientId),
          sessions,
          schedule,
        })
        setLoad('ready')
      })
      .catch(() => {
        if (!cancelled) {
          setLoad('unreachable')
        }
      })

    return () => {
      cancelled = true
    }
  }, [clientId, attempt])

  if (load === 'loading') {
    return (
      <TrainerShell>
        <p className="text-base text-muted" role="status">
          Loading this client
        </p>
      </TrainerShell>
    )
  }

  if (load === 'missing') {
    return (
      <TrainerShell>
        <h1 className="text-xl font-semibold text-ink-bold">Client not found</h1>
        <p className="mt-2 text-base text-muted">
          They may belong to another trainer, or the link may be wrong.
        </p>
        <Link className={`mt-6 inline-block text-base text-ink ${trainerLink}`} to="/clients">
          Back to clients
        </Link>
      </TrainerShell>
    )
  }

  if (load === 'unreachable' || detail === null) {
    return (
      <TrainerShell>
        <h1 className="text-xl font-semibold text-ink-bold">We couldn&rsquo;t load this client</h1>
        <p className="mt-2 text-base text-muted">Check your connection and try again.</p>
        {/* The accent: the only action on a screen that otherwise failed to load. */}
        <button
          className={`mt-6 ${trainerPrimary}`}
          onClick={() => setAttempt((previous) => previous + 1)}
          type="button"
        >
          Try again
        </button>
      </TrainerShell>
    )
  }

  const { client, programs, sessions, schedule } = detail
  const active = client.isActive !== false

  return (
    <TrainerShell>
      {/* text-sm text-muted now actually applies. trainerQuiet carried text-base text-ink of its
          own, so this string set the same two properties twice and the winner was whichever
          utility Tailwind emitted last. trainerLink sets neither. */}
      <Link className={`text-sm text-muted ${trainerLink}`} to="/clients">
        Back to clients
      </Link>

      {/* flex-wrap and min-w-0: a display name and an email address are both trainer-supplied,
          both unbounded, and at 390px there is no width at which "name on the left, Deactivated
          on the right" survives a long one of either. */}
      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold wrap-break-word text-ink-bold">{client.displayName}</h1>
          <p className="mt-1 wrap-break-word text-sm text-muted">{client.email}</p>
        </div>
        {!active && <p className="text-sm font-semibold text-danger">Deactivated</p>}
      </div>

      <p className="mt-1 text-sm text-muted">{client.timezone}</p>

      <Programs clientId={clientId} programs={programs} />

      <ReminderSchedule
        clientActive={active}
        clientId={clientId}
        onSaved={(saved) => setDetail((previous) => (previous === null ? previous : { ...previous, schedule: saved }))}
        schedule={schedule}
      />

      <History sessions={sessions} />
    </TrainerShell>
  )
}

// ui-ux.md's "edit entry point": this screen names the program and hands off, it does not edit.
// Days and prescriptions belong to the program builder (#52), which owns /programs/:id.
function Programs({ clientId, programs }: { clientId: string; programs: ProgramResponse[] }) {
  // Active first, then the rest by title. A client has one active program at most (the partial
  // unique index in #27 enforces it), and that is the one the trainer came to look at.
  const ordered = [...programs].sort((left, right) => {
    if (left.status !== right.status) {
      if (left.status === 'active') return -1
      if (right.status === 'active') return 1
    }
    return (left.title ?? '').localeCompare(right.title ?? '')
  })

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-ink-bold">Program</h2>

      {ordered.length === 0 ? (
        <p className="mt-2 text-base text-muted">
          No program yet. Build one and it shows up here.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-edge border-y border-edge">
          {ordered.map((program) => (
            <li className={`py-3 ${trainerRecordRow}`} key={program.id}>
              {/* The handoff, and the title is what carries it. This row used to render the
                  title as a dead <span> with an "Edit program" button opposite, which is the
                  two-controls-one-destination shape the roster rejects a few files over: the
                  title is what a trainer looks at, so it should be what they can click.

                  DESIGN.md §Controls settles which of the two survives — one way in per row —
                  and RecordLink is the treatment, the same one the roster's client names now
                  take, chevron included. Dropping the button also takes a bordered control out
                  of a section whose remaining one ("Build a program") is the actual next step. */}
              <RecordLink to={`/programs/${program.id}`}>{program.title}</RecordLink>
              <span className="block text-sm text-muted">
                {program.status}
                {program.startsOn != null && program.startsOn !== '' && ` · starts ${formatSessionDate(program.startsOn)}`}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Creating a program is also the builder's, and it takes a client id — which this screen
          is the only place that has one to hand.

          Bordered rather than amber even on a client with no program, where it is the most
          inviting thing in the section. It navigates; it does not write anything. The accent on
          this screen belongs to the schedule form's submit, which is the only control here that
          commits. Sending a trainer to another screen under the colour that means "this saves"
          is the sort of small lie that costs the palette its meaning. */}
      {/* inline-block dropped: trainerSecondary carries inline-flex of its own now (#135, so the
          label centres in a 44px box), and two display utilities in one string is a coin toss
          decided by stylesheet emission order rather than by anything here. */}
      <Link className={`mt-4 ${trainerSecondary}`} to={`/programs/new?client=${clientId}`}>
        {ordered.length === 0 ? 'Build a program' : 'Build another program'}
      </Link>
    </section>
  )
}

// The AC's third item, and the one with the most history behind it.
//
// Three facts from earlier tickets meet here:
//   * #29 binds send_time to a TimeOnly, so the wire format is HH:mm:ss and an HH:mm string is
//     a 400. lib/scheduleTime.ts owns that conversion in both directions.
//   * #29 deliberately allows schedules on deactivated clients: the worker re-checks
//     users.is_active at send time, so an edit here can express intent without leaking email.
//   * #25 disables schedules when a client is deactivated and does not re-enable them when the
//     client comes back. This form is where they come back on, and #50's reactivate control
//     points here in as many words.
// A client may also have no schedule at all, so the save is a POST or a PATCH depending on
// what came back from the GET.
function ReminderSchedule({
  clientActive,
  clientId,
  onSaved,
  schedule,
}: {
  clientActive: boolean
  clientId: string
  onSaved: (schedule: ScheduleResponse) => void
  schedule: ScheduleResponse | null
}) {
  const [sendTime, setSendTime] = useState(() => toInputTime(schedule?.sendTime))
  const [days, setDays] = useState<number[]>(() => schedule?.daysOfWeek ?? [])
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true)
  const [saving, setSaving] = useState(false)

  const block = useBlockMessage('schedule-message')

  // Whatever is in the slot describes the last save attempt, so it goes the moment a field
  // moves. Without this, "Pick at least one day." survived picking a day — the same staleness
  // #46 named and the program builder's status control had.
  const edited = block.clear

  function toggleDay(day: number) {
    edited()
    setDays((previous) =>
      previous.includes(day) ? previous.filter((candidate) => candidate !== day) : [...previous, day],
    )
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) {
      return
    }

    // Both checks mirror #29's own. Catching them here costs no round trip on either, and the
    // server's messages ("send_time is required", "days_of_week must be non-empty") are written
    // in wire-field names that mean nothing to someone looking at a form.
    if (sendTime.trim() === '') {
      block.fail('Pick a time to send the reminder.')
      return
    }
    if (days.length === 0) {
      block.fail('Pick at least one day.')
      return
    }

    setSaving(true)
    block.clear()

    // The seconds are the whole point of toApiTime. Sending "07:30" is a 400 from both routes.
    const body = { sendTime: toApiTime(sendTime), daysOfWeek: [...days].sort((a, b) => a - b), enabled }

    try {
      // POST creates, PATCH edits, and which one this is depends entirely on whether the GET
      // found a row. There is no upsert: POST answers 409 schedule_exists if one already
      // exists, and PATCH needs a schedule id this screen would not have.
      const result =
        schedule?.id === undefined
          ? await createClientSchedule(clientId, body)
          : await updateSchedule(schedule.id, body)

      onSaved(result)
      // Re-seeded from the response rather than left as typed: #29 normalizes days_of_week to
      // sorted-and-deduplicated, so the server's copy is the canonical one.
      setSendTime(toInputTime(result.sendTime))
      setDays(result.daysOfWeek ?? [])
      setEnabled(result.enabled ?? enabled)
      // Says which days the client will actually be emailed on, which is the whole outcome of
      // the form and the reason this confirmation carries more than "Saved."
      //
      // Built from the response rather than from the form state, for the same reason the fields
      // are re-seeded from it: #29 normalizes days_of_week, so the server's copy is the one that
      // describes what will actually be sent.
      block.done(
        `Saved. ${
          (result.enabled ?? enabled)
            ? `Sending ${describeDays(result.daysOfWeek ?? [])}.`
            : 'Reminders are off.'
        }`,
      )
    } catch (caught) {
      // 'schedule' rather than 'client': this form writes to the schedule, so a 404 here means
      // the schedule vanished (deleted from another tab), not that the client did. The roster
      // read above is what would catch a missing client.
      block.fail(messageFor(caught, 'schedule'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mt-10 max-w-xl">
      <h2 className="text-lg font-semibold text-ink-bold">Reminder emails</h2>

      {/* The two ways reminders end up off, said plainly, because a trainer looking at a
          disabled switch cannot tell from it which happened.

          Deactivation is the louder one: #25 turns the schedule off in the same transaction, so
          a reactivated client has reminders that stay off until someone flips this. #50's
          reactivate control says so and points here; this is the other end of that sentence. */}
      {!clientActive && (
        <p className="mt-2 text-sm text-ink">
          This client is deactivated, so nothing sends until you reactivate them. You can still
          set the schedule up ready for when they come back.
        </p>
      )}
      {clientActive && schedule !== null && schedule.enabled === false && (
        <p className="mt-2 text-sm text-ink">
          Reminders are off. They stop after a deactivation, or if the client paused them from a
          reminder email. Turning them back on is this switch.
        </p>
      )}
      {schedule === null && (
        <p className="mt-2 text-sm text-muted">
          No schedule yet. Pick a time and the days they train.
        </p>
      )}

      <form className="mt-6 grid gap-6" noValidate onSubmit={onSubmit}>
        <div className="grid gap-2">
          <label className="text-sm font-semibold text-ink" htmlFor="schedule-time">
            Send at
          </label>
          {/* type="time" for the platform's own picker. It speaks HH:mm; #29 speaks HH:mm:ss.
              toApiTime and toInputTime are the seam. */}
          <input
            className={`justify-self-start ${trainerField}`}
            id="schedule-time"
            name="sendTime"
            onChange={(event) => {
              setSendTime(event.target.value)
              edited()
            }}
            type="time"
            value={sendTime}
          />
          <p className="text-xs text-muted">In {'the client’s'} own timezone.</p>
        </div>

        <fieldset className="grid gap-2">
          {/* A fieldset because seven checkboxes are one question. Without the legend each box
              announces as a bare weekday with nothing saying what checking it means. */}
          <legend className="text-sm font-semibold text-ink">Days</legend>
          {/* #135: the tap target is the <label>, not the box. A native checkbox renders at
              about 13px, and seven of them is the densest row of controls in the trainer area —
              picking a client's training days on a phone was a game of darts. Clicking a label
              toggles its control, so giving the label the 44px height and the box a size the
              thumb can aim at fixes it without a custom control or a third-party checkbox.

              gap-y-2 because at 390px seven of these wrap to two lines, and two 44px rows with
              no gap between them read as one block of text. */}
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-2">
            {DAY_ABBREVIATIONS.map((label, day) => (
              <label
                className="flex min-h-[var(--tap-min)] items-center gap-2 text-sm text-ink"
                key={label}
              >
                <input
                  checked={days.includes(day)}
                  className="size-5"
                  name="daysOfWeek"
                  onChange={() => toggleDay(day)}
                  type="checkbox"
                  value={day}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="flex min-h-[var(--tap-min)] items-center gap-2 text-sm font-semibold text-ink">
          <input
            checked={enabled}
            className="size-5"
            name="enabled"
            onChange={(event) => {
              setEnabled(event.target.checked)
              edited()
            }}
            type="checkbox"
          />
          Send these reminders
        </label>

        {block.message !== null && (
          <Message id={block.id} tone={block.message.tone}>
            {block.message.body}
          </Message>
        )}

        {/* #138: both messages were unwired. The confirmation matters as much as the failure
            here, because it is the one that says which days the client will actually be
            emailed on — the whole outcome of the form, announced once and then unreachable. */}
        <button
          aria-describedby={block.describedBy}
          className={`justify-self-start ${trainerPrimary}`}
          disabled={saving}
          type="submit"
        >
          {saving ? 'Saving' : schedule === null ? 'Create schedule' : 'Save schedule'}
        </button>
      </form>
    </section>
  )
}

// The trainer's view of what the client has actually been doing — the same "who's slacking"
// question the roster answers with one date, opened up to the list behind it.
function History({ sessions }: { sessions: ClientSessionResponse[] }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-ink-bold">History</h2>

      {sessions.length === 0 ? (
        <p className="mt-2 text-base text-muted">Nothing logged yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-edge border-y border-edge">
          {sessions.map((session) => (
            <li className="grid gap-1 py-3" key={session.id}>
              <span className="text-base font-semibold text-ink-bold">
                {formatSessionDate(session.performedOn ?? '')}
              </span>
              {/* database.md calls the session comment the v1 substitute for messaging, which
                  makes it the most valuable thing on this list — it is the only channel the
                  client has to say "shoulder tweaked on OHP". Rendered in ink, not muted. */}
              {session.comment != null && session.comment !== '' && (
                <span className="text-sm text-ink">{session.comment}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
