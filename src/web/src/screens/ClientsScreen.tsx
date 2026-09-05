import { useEffect, useRef, useState } from 'react'

import type { ClientResponse } from '../api/types.gen'
import { ApiError, createClient, fetchClients, updateClient } from '../lib/api'
import { messageFor } from '../lib/apiMessages'
import { looksLikeEmail } from '../lib/email'
import { NO_VALUE } from '../lib/glyphs'
import { formatSessionDate } from '../lib/history'
import { unitLabel, type WeightUnit } from '../lib/weight'
import { todayIn } from '../lib/workoutDraft'
import { useBlockMessage } from './blockMessage'
import { Message } from './Message'
import { RecordLink } from './RecordLink'
import { TrainerShell } from './TrainerShell'
import {
  trainerDanger,
  trainerField,
  trainerPrimary,
  trainerRecordRow,
  trainerRecordRowControl,
  trainerSecondary,
} from './trainerControls'

type Load = 'loading' | 'ready' | 'unreachable'

// ui-ux.md §Trainer screens, Clients: "list + add/deactivate; per-client: last session date
// (the 'who's slacking' signal — the v1 stand-in for the deferred digest)". The trainer's
// landing screen, and the first one built.
//
// ── The last-session date arrives with the roster (#115) ───────────────────────────────────
// It used to be N separate requests, one per client, fired after the roster was already on
// screen. The comment here used to defend that and name the price: GET /api/clients/:id/sessions
// had no limit parameter and no summary field, so reading one date downloaded every session
// that client had ever logged. (That route is gone as of #147; this was its last caller.) That degrades with client *tenure* rather than roster size,
// which is why it looked cheap at four clients and would not have stayed cheap.
//
// ClientResponse now carries `lastSessionOn`, computed server-side as the max of that client's
// performed_on. The effect, the request-dedupe ref and the parallel state map are all gone with
// it, and so is the question they existed to answer.
//
// ── What that does to the three states, which is the part worth reading ────────────────────
// The cell has always had three: not known yet, known to be never, and a date. #50 fixed their
// meanings and the rule is that a *failed read must never render as "never trained"* — null is
// a claim about the client, and a timeout is not evidence for it.
//
// That rule gets easier to keep here, not harder. There is one read now, so a failure is the
// screen's failure: the roster renders "We couldn't load your clients" with a Try again, which
// is louder and more honest than a row of dashes was. `null` narrows to meaning only what it
// says.
//
// LastSession keeps its `undefined` branch anyway. The generated type is
// `lastSessionOn?: string | null`, so absence stays reachable, and a component that folded it
// into the null branch would render a missing field as "No sessions yet" — the same defect one
// refactor later.
export function ClientsScreen() {
  const [load, setLoad] = useState<Load>('loading')
  const [clients, setClients] = useState<ClientResponse[]>([])
  const [attempt, setAttempt] = useState(0)

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
          {/* The accent, because on this view it is the only thing to do. #114 gave every
              recovery control the link treatment, which put an underline on a <button> and left
              the one action on a dead screen looking like a footnote. */}
          <button
            className={trainerPrimary}
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
            <Roster clients={clients} onUpdated={onUpdated} />
          )}

          <AddClient onAdded={onAdded} />
        </>
      )}
    </TrainerShell>
  )
}

// A list that becomes columns, which is what the <table> here was reaching for and could not do.
//
// The original argument for the table still stands and is worth restating, because it is what
// this has to keep: the roster is parallel facts about several rows, read by comparing down a
// column, and the column of dates *is* the "who's slacking" signal ui-ux.md names. That is a
// table's job. What a table cannot do is stop being one — `<tr>`/`<td>` have a fixed layout
// algorithm, so four columns of real content on a 390px viewport either overflow or crush, and
// there is no width at which the trainer gets a legible roster instead.
//
// So the columns move to a grid that only exists at sm: and up. Below that each client is one
// stacked block; above it the same markup lays out as aligned columns and the down-column scan
// comes back. #135 revised ui-ux.md to make that ordering explicit — the table was the wide
// case all along, and it was being built as the only case.
//
// Deliberately not cards, and this is the part DESIGN.md constrains: a bordered box per client
// would be "a grid of identical boxes", which it bans by name, and it would say each client is
// a bounded unit meaningful alone when the whole point is comparing them. Same divide-y rule
// treatment the client detail screen's program and history lists already use.
//
// The header strip renders from sm: only, because a column header with nothing beside it to be
// a header *for* is a label the stacked layout does not need. What the stacked layout needs
// instead is that the values be self-describing, which they are ("3 days ago", "No sessions
// yet", "Active") — except the loading dash, which gets an sr-only label below.
function Roster({
  clients,
  onUpdated,
}: {
  clients: ClientResponse[]
  onUpdated: (client: ClientResponse) => void
}) {
  const today = todayIn(undefined)

  return (
    // The single grid. Everything below it is a subgrid of this one definition rather than a
    // copy of it — see COLUMNS for why a copy could not work.
    <div className={`mt-8 ${COLUMNS}`}>
      {/* aria-hidden, and that is not a shortcut. These four words are a visual aid for the
          wide layout; the row content below is self-describing, so exposing them would put a
          set of labels in the accessible tree that stand in no announced relationship to the
          values they sit above — which is the thing a real <th scope="col"> did and a grid
          cannot. What the table's semantics were buying, the wording is buying instead. */}
      <div aria-hidden="true" className={`hidden py-2 text-xs text-muted ${SUBGRID} sm:grid`}>
        <span>Client</span>
        <span>Last session</span>
        <span>Status</span>
        {/* Empty on purpose. The old <th> here held an sr-only "Actions", which was a label for
            a thing the buttons already say; with the header out of the tree there is nothing
            left for it to label.

            It is also the cell that broke the previous attempt: as a track of its own in a
            second grid, an empty span made column 4 zero-wide here and ~110px wide in every
            row, and the surplus went to the fr tracks, which is what pushed these three labels
            right of their values. In a subgrid the track is sized once, by the widest thing in
            it anywhere — the button — and this span simply sits in it. */}
        <span />
      </div>

      <ul
        aria-label="Your clients, with the date each last trained"
        className={`divide-y divide-edge border-y border-edge ${SUBGRID} sm:grid`}
      >
        {clients.map((client) => (
          <ClientRow client={client} key={client.id} onUpdated={onUpdated} today={today} />
        ))}
      </ul>
    </div>
  )
}

/**
 * The column definition, declared once, on the one element that owns it.
 *
 * This used to be applied to the header strip and to every row, on the theory that one shared
 * string could not drift. It drifted anyway, because `grid-template-columns` is not a layout —
 * it is an instruction resolved separately by each grid container against that container's own
 * content, and the same instruction in two containers is two different layouts as soon as the
 * content differs.
 *
 * Here it differed by construction. Tracks 3 and 4 are `auto`, so they take their width from
 * what is in them before the `fr` tracks divide up what is left: in the header those cells hold
 * the word "Status" and nothing at all, and in a row they hold "Deactivated" and a button. The
 * header therefore had ~190px more to give away, handed it to the two `fr` tracks in their 2:1
 * ratio, and every column boundary after the first landed further right than the rows' — about
 * 125px out at "Last session" and 190px by "Status". Column 1 matched, which is exactly what
 * made it read as an alignment problem rather than a sizing one.
 *
 * `justify-self-start` on both sides was the natural-looking fix and could not have worked:
 * justify-self positions an item *within its track* and cannot move the track. Both cells were
 * already start-aligned, so it changed nothing on screen.
 *
 * minmax(0,·) on the two flexible tracks rather than bare fr: a grid track's default minimum is
 * min-content, so an unbreakable email address or a long client name would push the track wider
 * than its share and take the row past the viewport with it. This is the same overflow the
 * exercise library's shrink-0 caused, in the grid dialect.
 *
 * gap-x only. Row spacing belongs to the stacked phone layout and is per-row (`gap-y-1` on the
 * li); the column gap is a property of the columns, so it is declared here with them.
 */
const COLUMNS = 'sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto] sm:gap-x-4'

/**
 * What everything under COLUMNS wears instead of a copy of it: span all four tracks, and take
 * the track *sizes* from the parent rather than re-deriving them.
 *
 * This is the fix. `subgrid` means the four tracks are measured once, over the header and every
 * row together — the `auto` columns come out as wide as the widest status word and the widest
 * button anywhere in the roster, and every cell in a column starts at the same x because there
 * is only one x to start at. It is what `<table>` did for free, and what two sibling grids
 * cannot reproduce at any gap or width.
 *
 * Nested deliberately: the <ul> is a subgrid of the wrapper, and each <li> is a subgrid of the
 * <ul>. The alternative — `display: contents` on both — flattens the rows into the outer grid
 * and destroys the boxes they need, since a row carries `relative isolate` for RecordLink's
 * stretched overlay, a hover background, and the divide-y rule between rows. Subgrid shares the
 * tracks and keeps every one of those.
 *
 * From sm: only. Below it there are no columns to share and no subgrid in play, so the stacked
 * phone layout — the primary one, per ui-ux.md — never depends on this.
 */
const SUBGRID = 'sm:col-span-4 sm:grid-cols-subgrid'

function ClientRow({
  client,
  onUpdated,
  today,
}: {
  client: ClientResponse
  onUpdated: (client: ClientResponse) => void
  today: string
}) {
  const [saving, setSaving] = useState(false)

  const active = client.isActive !== false
  const name = client.displayName ?? 'Client'

  // This row's one slot. Per-row id, because a roster renders one of these per client and a
  // shared one would point every row's control at the first row's message (#138).
  const block = useBlockMessage(`client-message-${client.id ?? name}`)

  async function setActive(isActive: boolean) {
    if (client.id === undefined || saving) {
      return
    }

    setSaving(true)
    block.clear()
    try {
      onUpdated(await updateClient(client.id, { isActive }))
      // Lands in the slot the prompt was in, which is what closes the prompt: the row is armed
      // exactly while the question is what is showing.
      //
      // Names the side effect on the way out for the same reason the prompt names it on the way
      // in: #25 switches the reminder schedule off in the same transaction, and a trainer who
      // reads "Deactivated" alone has no way to know that happened.
      block.done(
        isActive
          ? `${name} is active again. Their reminders stay off until you turn them back on.`
          : `${name} is deactivated. Their reminder emails have stopped.`,
      )
    } catch (caught) {
      block.fail(messageFor(caught, 'client'))
    } finally {
      setSaving(false)
    }
  }

  return (
    // gap-y-1, not gap-1. A subgrid takes its column gap from the parent unless it sets one of
    // its own, and setting one here would put the gutter back in two places — the exact shape
    // of duplication that produced the misalignment. The row gap is this element's own business
    // (it separates the stacked cells on a phone, where there are no columns at all).
    <li className={`grid gap-y-1 py-3 sm:items-start ${trainerRecordRow} ${SUBGRID}`}>
      {/* Before the trigger and full width, per DESIGN.md §Messages placement (#138). It used
          to render after the button, inside the actions cell, with an mt-2 to hold it off.
          Both were wrong: after, because the rule is before; and inside the cell, because the
          actions track is `auto` and sized across every row at once, so one row's error panel
          would have widened the actions column for the whole roster. Spanning all four tracks
          keeps the message with its row and out of the column geometry. */}
      {/* The row's one slot: the prompt that arms the deactivate, the refusal that came back, or
          the receipt that it landed. Three separate renders before #141, which is how a
          confirmation and an unanswered prompt could sit here together.

          Up here rather than in the actions cell with the buttons, and not for placement reasons
          — the rule is satisfied either way, since the row is the container that owns the
          trigger. It is a column-geometry constraint: track 4 is `auto` and subgrid sizes it
          across every row at once, so a panel inside that cell would set the actions column
          width for the whole roster. */}
      {block.message !== null && (
        <Message
          className={`${trainerRecordRowControl} sm:col-span-4`}
          id={block.id}
          tone={block.message.tone}
        >
          {block.message.body}
        </Message>
      )}

      <div className="min-w-0 sm:justify-self-start">
        {/* The way into the client detail screen (#51). The name is the link because it is what
            the trainer is already looking for when they scan the column; a separate "View"
            control would be a second thing in the row that goes where the first one points.

            RecordLink, not trainerLink: this is the identifying field of a table row, and an
            underline at rest put a rule under every name in the column, which is decoration
            spread evenly and so not a signal. What replaced it is a trailing chevron rather
            than nothing, because weight and ink are hierarchy and a name that is merely the
            boldest thing in its row reads as a heading. DESIGN.md §Controls. */}
        <RecordLink to={`/clients/${client.id}`}>{name}</RecordLink>
        {/* wrap-break-word because an email address has nothing in it a browser will break at,
            and one long address in a minmax(0,2fr) track is a row wider than the phone. */}
        <span className="block wrap-break-word text-sm text-muted">{client.email}</span>
      </div>

      <div className="sm:justify-self-start">
        {/* Straight off the roster row since #115. `onUpdated` replaces this whole record
            with the PATCH response, so the field has to be right on that response too — see
            LastSessionFor in ClientEndpoints.cs for why that is not a detail. */}
        <LastSession performedOn={client.lastSessionOn} today={today} />
      </div>

      <div className="text-sm text-ink sm:self-center sm:justify-self-start">
        {active ? 'Active' : 'Deactivated'}
      </div>

      {/* justify-self-start keeps this cell at its own width instead of stretching to fill the
          track — which now matters more than it did, because the track is sized across every
          row at once and the confirming state (a prompt plus two buttons) is the widest thing
          in it. A stretched resting cell would sit in a column sized for a state it is not in.

          It does not size the track, and the earlier version of this comment said it did. That
          misreading is what produced the failed alignment attempt: justify-self is item
          placement inside a track, never track geometry. See COLUMNS. */}
      <div className={`sm:self-center sm:justify-self-start ${trainerRecordRowControl}`}>
        {/* Read off the slot rather than a boolean beside it, so the row cannot be armed and
            confirmed at the same time. */}
        {block.prompting ? (
          // Inline, replacing the control that raised it, rather than a dialog over the page:
          // DESIGN.md calls the modal the lazy first answer, and #105/#108 settled the same
          // question for the client screens. The prompt names the side effect because it is
          // the part the trainer would not predict — deactivating also switches off their
          // reminder emails, in the same transaction (#25). It is the panel at the top of this
          // row; these are the two answers to it.
          <div aria-labelledby={block.id} className="flex flex-wrap gap-2" role="group">
            <button
              aria-describedby={block.id}
              className={trainerDanger}
              disabled={saving}
              onClick={() => void setActive(false)}
              type="button"
            >
              {saving ? 'Deactivating' : 'Deactivate'}
            </button>
            {/* Bordered, not amber. Dismissing is not committing, and a solid accent on the
                button that does nothing is the palette's one promise pointed at the wrong
                control. The confirmation prompt above is what makes this the safe exit.
                It writes nothing into the slot: a cancelled question needs no receipt. */}
            <button className={trainerSecondary} onClick={block.clear} type="button">
              Cancel
            </button>
          </div>
        ) : (
          /* The headline defect in #132: one control, two opposite meanings, one appearance.
             Deactivating takes a client's access and their reminders away; reactivating gives
             them back. Which of the two this button is depended entirely on a word, so the two
             states now take different treatments — --danger arming the confirmation, bordered
             neutral for the way back. Reactivate deliberately gets no colour of its own: a
             green here is the success hue DESIGN.md refuses by name. */
          /* #135 took the client's name out of the visible label and put it in aria-label. The
             accessible name is byte-for-byte what it was, which is the whole reason this is the
             right move rather than a loss: a screen reader going down the roster still hears
             "Deactivate Ada", because that is the context a linear reading has no other way to
             get. A sighted trainer reads it off the name at the head of the row — which on a
             phone is directly above this button rather than four columns to the left. */
          <button
            aria-describedby={block.describedBy}
            aria-label={
              saving ? `Saving ${name}` : active ? `Deactivate ${name}` : `Reactivate ${name}`
            }
            className={active ? trainerDanger : trainerSecondary}
            disabled={saving}
            onClick={() =>
              active
                ? block.ask(<>Deactivate {name}? Their reminder emails stop too.</>)
                : void setActive(true)
            }
            type="button"
          >
            {saving ? 'Saving' : active ? 'Deactivate' : 'Reactivate'}
          </button>
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
      </div>
    </li>
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
    // The field was not on the record. One dash, and no claim either way.
    //
    // Before #115 this was the common case — the date arrived in its own request, so a cell
    // was undefined while that request was in flight and stayed undefined if it failed. Now the
    // date rides in with the roster, so there is no in-flight state and a failed read takes the
    // whole screen to its own error. What is left is the generated type: `lastSessionOn` is
    // optional, so absence is still expressible, and it must not fall through to the null
    // branch below. Rendering a field the server did not send as "No sessions yet" is #50's
    // defect wearing a different cause.
    //
    // The sr-only half is what the dropped <th> used to provide. Every other value this
    // component renders says what it is ("3 days ago", "No sessions yet"); a bare dash in a
    // stacked layout, with no column header above it and no label beside it, is the one that
    // announces as nothing at all.
    return (
      <span className="text-base text-muted tabular-nums">
        <span className="sr-only">Last session not known</span>
        <span aria-hidden="true">{NO_VALUE}</span>
      </span>
    )
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
  const [weightUnit, setWeightUnit] = useState<WeightUnit>('lb')
  const [submitting, setSubmitting] = useState(false)
  const block = useBlockMessage('add-client-message')

  // Which field the message in the slot is about, when it is about one. Without it, "Enter their
  // name" also marked the email input aria-invalid, so a screen reader announced the wrong field
  // as the broken one — worse than no marking, because it sends someone to fix what is already
  // right.
  //
  // Kept beside the slot rather than in it, and then *derived* back against it: the attribution
  // only means anything while a failure is what is showing, so a stale value cannot mark a field
  // invalid under a confirmation. That is the #141 rule applied to the one thing the slot does
  // not itself carry.
  const [field, setField] = useState<'name' | 'email' | null>(null)
  const invalid = block.message?.tone === 'failure' ? field : null

  function reject(message: string, about: 'name' | 'email' | null) {
    setField(about)
    block.fail(message)
  }

  const emailRef = useRef<HTMLInputElement | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) {
      return
    }

    const address = email.trim()
    const name = displayName.trim()

    if (name === '') {
      reject('Enter their name.', 'name')
      nameRef.current?.focus()
      return
    }

    // #114: checked here rather than left to the browser. The form carries noValidate, so
    // `type="email"` no longer blocks submission with a native bubble — which is what "failing
    // silently" looked like, since the bubble is unstyled, inconsistent across browsers, and
    // in some of them never appears for an off-screen field. This message is in the page and
    // announced.
    //
    // The rule is looser than the server's on purpose (see lib/email.ts). Anything it lets
    // through that the server refuses comes back as the server's own message below, which is
    // why the two do not need to agree.
    if (!looksLikeEmail(address)) {
      // Deliberately the same sentence POST /api/clients answers with. The trainer should not
      // be able to tell which layer refused the address, because the distinction is ours, not
      // theirs: whether a typo is caught here or one round trip later is an implementation
      // detail of where the rules happen to differ in strictness.
      reject('Please enter a valid email address.', 'email')
      emailRef.current?.focus()
      return
    }

    setSubmitting(true)
    block.clear()
    try {
      const created = await createClient({
        email: address,
        displayName: name,
        timezone,
        weightUnit,
      })
      onAdded(created)
      block.done(`${created.displayName ?? address} added. Tell them to log in.`)
      setEmail('')
      setDisplayName('')
    } catch (caught) {
      // Nothing the trainer typed is cleared: the whole point is that they can fix it.
      //
      // Attributed to the email field only when the rejection is actually about the address —
      // 400 for a format the looser client rule let through (#114), 409 for one already in use.
      // Marking the input aria-invalid for a dropped connection or an expired session would
      // send a screen reader user to fix an address that is perfectly fine, which is the same
      // defect #114 found when one error string marked every field.
      const aboutTheAddress =
        caught instanceof ApiError &&
        (caught.code === 'bad_request' || caught.code === 'email_taken')

      reject(messageFor(caught, 'client'), aboutTheAddress ? 'email' : null)
    } finally {
      setSubmitting(false)
    }
  }

  // #114 item 4: the form used to carry a "Done" button beside "Add client", which read as two
  // ways to finish it. Removed rather than renamed to "Cancel", because after a successful add
  // there is nothing to cancel — the client exists and the form is standing open for the next
  // one, so "Cancel" would be a lie in exactly the state a trainer is most likely to be in.
  //
  // Closing is dismissal, not completion, so it does not belong in the form's footer at all.
  // The disclosure that opened the form closes it, and says which it will do. One completion
  // path in the form, one toggle outside it.
  // Amber while closed, bordered once open. Adding a client is what this screen is *for*, and
  // with the accent scoped to the form's submit the roster had no amber on it at all until you
  // opened this — a screen teaching nothing about the one colour the palette spends. Opening it
  // hands the accent to the submit below, and the relabel is what keeps that from being two
  // primaries: "Close" is a dismissal, and dismissals are never amber. (DESIGN.md §Controls.)
  const toggle = (
    <button
      aria-expanded={open}
      className={`mt-8 ${open ? trainerSecondary : trainerPrimary}`}
      onClick={() => {
        setOpen((previous) => !previous)
        block.clear()
      }}
      type="button"
    >
      {open ? 'Close' : 'Add a client'}
    </button>
  )

  if (!open) {
    return toggle
  }

  return (
    <>
      {toggle}
      <section className="mt-8 max-w-xl rounded-md border border-edge p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-ink-bold">Add a client</h2>

        {/* api.md is explicit that POST /api/clients sends nothing: "invite = trainer tells them
            to log in via magic link". So the screen says what did not happen, because a trainer
            who assumes an invite went out is a client who never hears from anyone. */}
        <p className="mt-1 text-sm text-muted">
          No email is sent. Tell them to log in with this address and they&rsquo;ll get a link.
        </p>

        {/* noValidate: the browser's own bubble for type="email" is unstyled, worded differently
            in every browser, and accepts things the server refuses (ada@b passes it). Turning it
            off makes the message below the only one, which is the one that can be written, tested,
            and announced. */}
        <form className="mt-6 grid gap-4" noValidate onSubmit={onSubmit}>
          <div className="grid gap-2">
            <label className="text-sm font-semibold text-ink" htmlFor="client-name">
              Name
            </label>
            <input
              aria-describedby={invalid === 'name' ? block.id : undefined}
              aria-invalid={invalid === 'name'}
              className={trainerField}
              id="client-name"
              name="displayName"
              onChange={(event) => setDisplayName(event.target.value)}
              ref={nameRef}
              required
              value={displayName}
            />
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-semibold text-ink" htmlFor="client-email">
              Email
            </label>
            <input
              aria-describedby={invalid === 'email' ? block.id : undefined}
              aria-invalid={invalid === 'email'}
              autoCapitalize="none"
              className={trainerField}
              id="client-email"
              name="email"
              onChange={(event) => setEmail(event.target.value)}
              ref={emailRef}
              required
              spellCheck={false}
              type="email"
              value={email}
            />
          </div>

          {/* #99. The trainer sets the default; the client corrects it themselves from the log
              screen's toggle, which is where the question actually arises. Defaulted to lb
              because most Canadian gyms load pound plates — the same reason the column's
              default is lb — so this control is usually left alone. */}
          <div className="grid gap-2">
            <label className="text-sm font-semibold text-ink" htmlFor="client-weight-unit">
              Weight unit
            </label>
            <select
              className={`justify-self-start ${trainerField}`}
              id="client-weight-unit"
              name="weightUnit"
              onChange={(event) => setWeightUnit(event.target.value === 'kg' ? 'kg' : 'lb')}
              value={weightUnit}
            >
              {/* The value is the stored enum, the label is what a person reads. See
                  unitLabel: 'lb' is the symbol the column carries, "lbs" is what is painted
                  on the plates. */}
              <option value="lb">{unitLabel('lb')}</option>
              <option value="kg">{unitLabel('kg')}</option>
            </select>
            <p className="text-xs text-muted">
              What they log and read weights in. They can change it themselves.
            </p>
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
              className={trainerField}
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

          {block.message !== null && (
            <Message id={block.id} tone={block.message.tone}>
              {block.message.body}
            </Message>
          )}

          {/* One button, because there is one way to finish this form. See `toggle` above for
              why the second one is gone.

              Described by whichever message is showing (#138). The failure already points the
              offending field at itself; this is the other half, for someone who tabs back to
              the submit rather than to the field. One slot means one id here rather than the
              three-way ternary this was. */}
          <button
            aria-describedby={block.describedBy}
            className={`justify-self-start ${trainerPrimary}`}
            disabled={submitting}
            type="submit"
          >
            {submitting ? 'Adding' : 'Add client'}
          </button>
        </form>
      </section>
    </>
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
