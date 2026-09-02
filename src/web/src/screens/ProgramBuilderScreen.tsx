import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import type {
  DayView,
  ExerciseResponse,
  PrescriptionView,
  ProgramDetailResponse,
} from '../api/types.gen'
import {
  ApiError,
  createDay,
  createPrescription,
  deleteDay,
  deletePrescription,
  deleteProgram,
  fetchExercises,
  fetchProgram,
  orNull,
  reorderDayExercises,
  updateDay,
  updatePrescription,
  updateProgram,
} from '../lib/api'
import { messageFor } from '../lib/apiMessages'
import { checkPrescriptionText } from '../lib/prescriptionText'
import { unitLabel, unitOf, type WeightUnit } from '../lib/weight'
import { useBlockMessage } from './blockMessage'
import { Message } from './Message'
import { TrainerShell } from './TrainerShell'
import {
  trainerDanger,
  trainerField,
  trainerLink,
  trainerPrimary,
  trainerSecondary,
  trainerSelected,
} from './trainerControls'

// 'deleted' is a terminal state, not a step on the way to one. See DeleteProgram for why the
// screen becomes a receipt rather than navigating away.
type Load = 'loading' | 'ready' | 'missing' | 'unreachable' | 'deleted'

const STATUSES = ['draft', 'active', 'archived']

// ui-ux.md §Trainer screens, Program builder: "days → prescriptions; add exercise from library;
// drag-or-buttons reorder". #53 built the day and prescription editing; #54 filled in the two
// controls it left disabled — the picker and the reorder buttons.
//
// ── Reordering days is deliberately not here ───────────────────────────────────────────────
// Prescriptions reorder through PATCH /api/days/:id/order, which takes the complete list and
// rewrites positions 1..N in one transaction. Days have no equivalent: they carry a position
// and PATCH /api/days/:id accepts it one row at a time. Reordering four days would be four
// requests with no transaction around them, and a failure in the middle leaves two days
// claiming the same position — which every reader of this tree then orders arbitrarily,
// including the client's Today screen. api.md rejected fractional positions to avoid exactly
// that class of drift; doing it by hand here would reintroduce it in the client's view of
// their own week. The fix is an endpoint that mirrors the prescription one, which is API work
// and not this ticket.
//
// ── One read, then local state ─────────────────────────────────────────────────────────────
// GET /api/programs/:id returns the whole tree — days, their prescriptions, each prescription's
// exercise — since the tree-read ticket. Every write endpoint returns the row it changed, so
// this screen folds those responses into its copy instead of re-reading. Refetching after each
// save would be simpler and would also throw away focus and scroll on a screen that exists to
// take a long sequence of small edits.
//
// ── Free text is not a lenient number ──────────────────────────────────────────────────────
// target_reps and target_load are text columns by design (database.md): "8–10", "AMRAP",
// "RPE 8", "5/3/1" are all real prescriptions a trainer writes. So those two are text inputs
// and render verbatim. target_sets and rest_seconds are genuinely integers and get number
// inputs. Getting this backwards would quietly forbid half the prescriptions in the sport.
export function ProgramBuilderScreen() {
  const { programId = '' } = useParams()

  const [load, setLoad] = useState<Load>('loading')
  const [program, setProgram] = useState<ProgramDetailResponse | null>(null)
  const [library, setLibrary] = useState<ExerciseResponse[]>([])
  const [attempt, setAttempt] = useState(0)

  // The Days section's own block. A deleted day takes its card and every slot in it off the
  // screen, so the section that owns the list is the nearest container that outlives the write.
  const section = useBlockMessage('days-message')

  useEffect(() => {
    let cancelled = false
    setLoad('loading')

    // The library is fetched once for the screen rather than per day: it is the same list
    // whichever day is being filled in, and one request beats one per day on a program with
    // five of them.
    Promise.all([fetchProgram(programId), fetchExercises()])
      .then(([tree, exercises]) => {
        if (!cancelled) {
          setProgram(tree)
          setLibrary(exercises)
          setLoad('ready')
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return
        }
        // A program id belonging to another trainer is a 404 exactly like a fabricated one,
        // which is the point — nothing here can tell a trainer that someone else's program
        // exists. Both land on the same screen.
        setLoad(caught instanceof ApiError && caught.status === 404 ? 'missing' : 'unreachable')
      })

    return () => {
      cancelled = true
    }
  }, [programId, attempt])

  /**
   * What the picker may offer: the trainer's library minus anything retired.
   *
   * #26 soft-deletes, and GET /api/exercises deliberately returns inactive rows too so the
   * library screen can bring one back. But #28 refuses a retired exercise on a new
   * prescription with 400 unknown_exercise, so listing one here would be offering a choice the
   * server has already made. Filtered once, at the top, rather than in each day's form.
   *
   * Prescriptions that already name a retired exercise are a separate question and keep
   * rendering — the tree read carries the exercise whether or not it is active, which is what
   * lets a trainer see the thing they need to replace.
   */
  const selectable = library.filter((exercise) => exercise.isActive !== false)

  function replaceDays(days: DayView[]) {
    setProgram((previous) => (previous === null ? previous : { ...previous, days }))
  }

  if (load === 'loading') {
    return (
      <TrainerShell>
        <p className="text-base text-muted" role="status">
          Loading this program
        </p>
      </TrainerShell>
    )
  }

  if (load === 'missing') {
    return (
      <TrainerShell>
        <h1 className="text-xl font-semibold text-ink-bold">Program not found</h1>
        {/* "Deleted" leads, because since #118 it is the likeliest way a trainer reaches this
            screen: delete a program, then reload the URL or come back to an open tab. The other
            two reasons stay, and listing three possibilities is what keeps this from being an
            existence oracle — a cross-tenant id and a fabricated one read identically here. */}
        <p className="mt-2 text-base text-muted">
          It may have been deleted, it may belong to another trainer, or the link may be wrong.
        </p>
        <Link className={`mt-6 inline-block text-base text-ink ${trainerLink}`} to="/clients">
          Back to clients
        </Link>
      </TrainerShell>
    )
  }

  if (load === 'unreachable' || program === null) {
    return (
      <TrainerShell>
        <h1 className="text-xl font-semibold text-ink-bold">We couldn&rsquo;t load this program</h1>
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

  /**
   * The receipt (#118).
   *
   * Every other write on this screen is acknowledged in the slot of the block that made it, and
   * this one has no such block to go back to: the program is the screen, so a delete takes the
   * Days section, the status control and its own cluster with it. Navigating to the client
   * instead would drop the only acknowledgement of the most destructive write in the builder,
   * and a program that was never in that client's list looks exactly like one just removed from
   * it.
   *
   * So the screen becomes the receipt. It is a terminal state rather than a slot, which is why
   * #141's auto-dismiss does not apply: a confirmation expires because the block it sits in
   * outlives it and has other work to do. There is nothing left here to get back to.
   *
   * Reloading this URL does not land here — this state is held in memory, and the fetch on mount
   * gets the 404 the row is now gone, which is the `missing` screen above. That is the correct
   * destination for a second visit: by then the trainer is not being told what happened, they
   * are asking for something that does not exist.
   */
  if (load === 'deleted') {
    return (
      <TrainerShell>
        <h1 className="text-xl font-semibold text-ink-bold">{program.title} is deleted</h1>
        <Message className="mt-6" tone="confirmation">
          Its days and exercises went with it. Nothing had been logged against it.
        </Message>
        {program.clientId != null && (
          <Link
            className={`mt-6 inline-block text-base text-ink ${trainerLink}`}
            to={`/clients/${program.clientId}`}
          >
            Back to client
          </Link>
        )}
      </TrainerShell>
    )
  }

  const days = program.days ?? []
  // Read once here and handed down, so the hint on every Load field says the same thing (#99).
  const clientWeightUnit = unitOf(program.clientWeightUnit)

  return (
    <TrainerShell>
      {program.clientId != null && (
        <Link className={`text-sm text-muted ${trainerLink}`} to={`/clients/${program.clientId}`}>
          Back to client
        </Link>
      )}

      {/* The saved title, and the page's heading. It is deliberately not the input below: while
          the trainer is typing, this is what the program is still called, which is the same
          relationship the day cards already have between `day.title` and their name field. */}
      <h1 className="mt-4 text-xl font-semibold text-ink-bold">{program.title}</h1>

      <ProgramName
        onChanged={(updated) =>
          setProgram((previous) => (previous === null ? previous : { ...previous, title: updated.title }))
        }
        programId={programId}
        title={program.title ?? ''}
      />

      <ProgramStatus
        onChanged={(updated) =>
          setProgram((previous) => (previous === null ? previous : { ...previous, status: updated.status }))
        }
        programId={programId}
        status={program.status ?? 'draft'}
      />

      {/* grid gap-6, so the confirmation below spaces itself from the container like every other
          message rather than carrying an mt-* of its own (DESIGN.md §Messages: a margin on a
          message is the smell that the placement bug has come back). The three children that
          were spacing themselves gave their margins up to it. */}
      <section className="mt-10 grid gap-6">
        <h2 className="text-lg font-semibold text-ink-bold">Days</h2>

        {/* A deleted day takes its own card, and every message slot in it, off the screen — so
            without this the most destructive write in the builder is the one write with no
            acknowledgement at all. */}
        {section.message !== null && (
          <Message id={section.id} tone={section.message.tone}>
            {section.message.body}
          </Message>
        )}

        {days.length === 0 ? (
          <p className="text-base text-muted">No days yet. Add the first one below.</p>
        ) : (
          <ul className="grid gap-6">
            {days.map((day) => (
              <Day
                clientWeightUnit={clientWeightUnit}
                day={day}
                key={day.id}
                library={selectable}
                onChanged={(next) =>
                  replaceDays(days.map((candidate) => (candidate.id === next.id ? next : candidate)))
                }
                onDeleted={(title) => {
                  section.done(
                    `${title} deleted. Workouts your client already logged against it stay in their history.`,
                  )
                  replaceDays(days.filter((candidate) => candidate.id !== day.id))
                }}
              />
            ))}
          </ul>
        )}

        <AddDay
          onAdded={(created) => {
            // Adding a day is an action in this section, so it takes the slot from the deletion
            // receipt that was in it.
            section.clear()
            replaceDays([
              ...days,
              // The create response is a ProgramDayResponse, which has no prescriptions array
              // because a new day has none. Given an empty one here so the day renders like any
              // other rather than as a special case until the next reload.
              { id: created.id, title: created.title, position: created.position, prescriptions: [] },
            ])
          }}
          programId={programId}
        />
      </section>

      <DeleteProgram
        onDeleted={() => setLoad('deleted')}
        programId={programId}
        title={program.title ?? 'this program'}
      />
    </TrainerShell>
  )
}

/**
 * Renaming the program (#118).
 *
 * PATCH /api/programs/:id has accepted `title` since #27 and `updateProgram` has passed it
 * through since the builder was built; nothing ever called it. The title was set once on the
 * New program screen and then rendered as a dead heading, so a typo was permanent and the only
 * way to correct one was to build the program again — which is the workaround #118's delete
 * exists to make possible, arriving at a problem it should not have to solve.
 *
 * The day cards' rename form, in the same shape and for the same reason: same endpoint
 * convention, same one-field block, same "the message goes when the field moves" rule.
 */
function ProgramName({
  onChanged,
  programId,
  title,
}: {
  onChanged: (program: { title?: string | null }) => void
  programId: string
  title: string
}) {
  const [draft, setDraft] = useState(title)
  const [saving, setSaving] = useState(false)

  const block = useBlockMessage('program-name-message')

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) {
      return
    }

    // Mirrors the API's own check, which says "title cannot be blank" — true, and written for
    // whoever is reading a response body rather than for the person holding the phone.
    if (draft.trim() === '') {
      block.fail('A program needs a name.')
      return
    }

    setSaving(true)
    block.clear()
    try {
      onChanged(await updateProgram(programId, { title: draft.trim() }))
      block.done('Name saved.')
    } catch (caught) {
      block.fail(messageFor(caught, 'program'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="mt-4 flex flex-wrap items-end gap-3" noValidate onSubmit={onSubmit}>
      <div className="grid gap-2">
        <label className="text-sm font-semibold text-ink" htmlFor="program-title">
          Program name
        </label>
        <input
          className={trainerField}
          id="program-title"
          name="title"
          onChange={(event) => {
            setDraft(event.target.value)
            block.clear()
          }}
          value={draft}
        />
      </div>

      {/* w-full, so the panel takes its own line in the flex-wrap row and lands between the field
          and the submit rather than beside them (DESIGN.md §Messages). */}
      {block.message !== null && (
        <Message className="w-full" id={block.id} tone={block.message.tone}>
          {block.message.body}
        </Message>
      )}

      {/* "Save program name", not the day cards' "Save name". A program of four days renders
          five rename forms, and the day cards were already the ambiguous set among themselves;
          adding a fifth identical control at the top would make the *screen-level* one
          indistinguishable from them by ear. Same finding ui-ux.md records for the library rows,
          answered in the visible label rather than an aria-label, because there is room for it
          here and a visible label that differs from the accessible name is its own problem. */}
      <button
        aria-describedby={block.describedBy}
        className={trainerPrimary}
        disabled={saving}
        type="submit"
      >
        {saving ? 'Saving' : 'Save program name'}
      </button>
    </form>
  )
}

/**
 * Deleting the program (#118), and the one refusal it can hit.
 *
 * At the foot of the screen, below the days, per ui-ux.md §Gym-floor constraints: the action
 * that commits sits at the end of the flow it belongs to. This one belongs to the whole screen
 * rather than to any block in it, which is also why it is the last thing on it.
 *
 * ── What the prompt says, and what it deliberately does not ────────────────────────────────
 * The day and prescription prompts both end with a reassurance: the client's logged history
 * survives, keyed by what it points at. That promise is true of one day and false of a whole
 * program, and this prompt does not make it. The API is what makes it true instead — a program
 * with anything logged against it is refused with a 409 that names the reason and points at
 * archive, so the only program that reaches a successful delete here is one nothing points at.
 *
 * ── Why the button is not disabled on a trained program ────────────────────────────────────
 * The builder could be told at load time whether the program has history, and then this control
 * could be hidden. It would be wrong twice: the answer is stale the moment the client logs a
 * set, and a control that vanishes explains nothing. The refusal is a message the trainer can
 * act on, with the Archived button a few hundred pixels above it.
 */
function DeleteProgram({
  onDeleted,
  programId,
  title,
}: {
  onDeleted: () => void
  programId: string
  title: string
}) {
  const [deleting, setDeleting] = useState(false)

  const block = useBlockMessage('program-delete-message')

  async function remove() {
    if (deleting) {
      return
    }

    setDeleting(true)
    try {
      await deleteProgram(programId)
      onDeleted()
    } catch (caught) {
      // Replaces the question rather than stacking under it, and disarms the cluster with it —
      // the same rule the prescription row follows. A 409 here is the endpoint's real content,
      // and the server's sentence is rendered as written: it names which reference blocks the
      // delete, and lib/apiMessages.ts records why remapping it would say less.
      block.fail(messageFor(caught, 'program'))
      setDeleting(false)
    }
  }

  return (
    <section className="mt-10 grid justify-items-start gap-2 border-t border-edge pt-6">
      {/* One slot: the question, or the refusal that replaced it (#141). */}
      {block.message !== null && (
        <Message id={block.id} tone={block.message.tone}>
          {block.message.body}
        </Message>
      )}

      {/* Arming swaps the control row in place, rather than adding a second row below the
          trigger — so there is one Delete on screen and the answers sit directly under the
          question they answer. */}
      {block.prompting ? (
        <div aria-labelledby={block.id} className="flex flex-wrap gap-2" role="group">
          <button
            aria-describedby={block.id}
            className={trainerDanger}
            disabled={deleting}
            onClick={() => void remove()}
            type="button"
          >
            {deleting ? 'Deleting' : 'Delete program'}
          </button>
          <button className={trainerSecondary} onClick={block.clear} type="button">
            Cancel
          </button>
        </div>
      ) : (
        /* "Delete this program", not "Delete {title}" — which is what the day card directly
           above does, and which does not survive being given a program's title. A button label
           cannot shrink: `flex-wrap` wraps *between* controls, and a single item wider than the
           viewport overflows it, which is #135's finding on the library rows. Day titles are
           "Lower" and "Push"; program titles are "Hypertrophy Block, February to April" —
           database.md's own example runs to four words.

           #135's answer for a long label is to move the naming form into `aria-label`, and it
           deliberately is not applied here. That rule exists because a library of forty rows
           offers forty buttons called "Retire" with nothing to tell them apart by ear. There is
           exactly one of these on the screen, so there is no ambiguity for a name to resolve,
           and the title is in the prompt a line above — inside a panel that wraps, which is
           where an unbounded string belongs. */
        <button
          className={trainerDanger}
          onClick={() =>
            block.ask(
              <>
                <p>Delete {title}? Its days and exercises go with it.</p>
                {/* Names archive here as well as in the refusal, because a trainer who wants
                    the program out of the way and has not thought about history should meet the
                    alternative before pressing rather than only after being refused. */}
                <p className="font-normal">
                  This cannot be undone. If your client has trained on it, archive it instead.
                </p>
              </>,
            )
          }
          type="button"
        >
          Delete this program
        </button>
      )}
    </section>
  )
}

// AC item 2: the transition, and the one conflict it can hit.
//
// #27 leaves transitions unrestricted between draft/active/archived — any to any — with a
// single structural gate: a partial unique index means one active program per client, so
// activating a second is a 409 rather than a silent swap. That 409 is the only failure here a
// trainer can act on, and its meaning ("archive the other one first") is not in the status code.
function ProgramStatus({
  onChanged,
  programId,
  status,
}: {
  onChanged: (program: { status?: string | null }) => void
  programId: string
  status: string
}) {
  const [saving, setSaving] = useState<string | null>(null)

  /**
   * This block's one message.
   *
   * It used to be an `{ status, message, committed }` record with two values derived off it,
   * which was #46's lesson applied by hand to one control: a captured 409 outlives the condition
   * it describes, so the record tracked *which* transition each note was about and the render
   * checked that against the current status before showing anything.
   *
   * The slot subsumes all of it (#141). Every path through `choose` writes the slot, so a note
   * cannot survive the next thing the trainer does — which is what the record's bookkeeping was
   * reconstructing. The one clause it also enforced, "the conflict goes if the program reaches
   * that status by any route", is not lost: in v1 the only thing that moves this program's
   * status is this function, and it clears the slot on the way in.
   */
  const block = useBlockMessage('program-status-message')

  async function choose(next: string) {
    if (saving !== null) {
      return
    }

    // Cleared before the no-op check rather than after it. Clicking the current status is how
    // someone dismisses a message about a transition they have thought better of, and under the
    // old order that click returned early and left the message standing.
    //
    // It is also why a dismissal must not land in the slot as a confirmation: nothing was
    // written, and "Draft." after a click that did nothing is a receipt for a non-event.
    block.clear()
    if (next === status) {
      return
    }

    setSaving(next)
    try {
      onChanged(await updateProgram(programId, { status: next }))
      // Names the consequence rather than the state, because the state is already on the button:
      // what a trainer cannot see from here is that activating is what puts the program in front
      // of the client.
      block.done(
        next === 'active'
          ? 'Active. Your client sees this program on their Today screen now.'
          : next === 'archived'
            ? 'Archived. Your client no longer sees this program.'
            : 'Back to draft. Your client no longer sees this program.',
      )
    } catch (caught) {
      // This used to concatenate an instruction onto the server's own sentence, which meant the
      // trainer read one sentence written for them and one written for a developer, joined. The
      // whole message for program_active_conflict now lives in the copy map, so rewording the
      // API's string cannot change what a trainer sees here.
      block.fail(messageFor(caught, 'program'))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="mt-4 grid justify-items-start gap-2">
      {/* Before the group, per DESIGN.md §Messages (#138). A rejected transition used to render
          under the three buttons with an mt-2; the grid gap above now spaces it and the panel
          carries no margin of its own. */}
      {/* The transition that worked said nothing at all before #140. The inverted button is a
          statement about which status the program is in, not about a write having landed — it
          looks identical whether the trainer just moved the program or loaded the page with it
          already there. Activating a client's program is the most consequential write on this
          screen and it was the quietest. */}
      {block.message !== null && (
        <Message id={block.id} tone={block.message.tone}>
          {block.message.body}
        </Message>
      )}

      {/* flex-wrap: three 44px buttons at ~80px each plus gaps is most of a 390px viewport, and
          "Archived" saving reads "Saving", which is wider. It wraps rather than overflows. */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Program status">
        {/* Inverted for the current status, bordered for the two you could move to.
            #132: this group used to paint the *current* status in solid amber, which is the one
            button in the row that does nothing when pressed. DESIGN.md gives amber exactly one
            job — "amber means the thing to tap" — and spending it on the already-selected state
            told a trainer to press the status they were already in, while the two real
            transitions sat next to it looking like nothing.

            Taking the amber off was step one; the first replacement was --surface-sunk, which
            the browser pass caught as its own regression. At 97% against a 99% surface that is
            about 1.03:1, so "is this program active or archived" was answered by a difference
            you cannot see across a desk. This is the whole reason a trainer opens this screen,
            and it was the faintest thing on it. Inverted neutral now, per DESIGN.md §Controls. */}
        {STATUSES.map((candidate) => {
          const current = candidate === status
          return (
            <button
              aria-describedby={block.describedBy}
              aria-pressed={current}
              className={current ? trainerSelected : trainerSecondary}
              disabled={saving !== null}
              key={candidate}
              onClick={() => void choose(candidate)}
              type="button"
            >
              {saving === candidate ? 'Saving' : capitalize(candidate)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Day({
  clientWeightUnit,
  day,
  library,
  onChanged,
  onDeleted,
}: {
  /** Passed straight through to each prescription's Load hint (#99). */
  clientWeightUnit: WeightUnit
  day: DayView
  library: ExerciseResponse[]
  onChanged: (day: DayView) => void
  onDeleted: (title: string) => void
}) {
  const [title, setTitle] = useState(day.title ?? '')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [reordering, setReordering] = useState(false)

  /**
   * Three blocks, not one, and the boundary is DESIGN.md's: a block is a trigger and the slot
   * immediately before it. This card holds three triggers separated by a whole prescription
   * list, and one slot for the card could not be "before" all of them — a rename failure would
   * render at the foot of the day, past the exercises, which is the placement defect #138 spent
   * a ticket removing.
   *
   * Per-day ids, because a program renders one card per day (#138).
   */
  const rename = useBlockMessage(`day-rename-message-${day.id ?? ''}`)
  // The list's slot. It carries the reorder failure — the arrows that produce it are inside the
  // list — and the confirmation for a removed prescription, which is held here rather than by
  // the row because the row is gone by the time there is anything to confirm.
  const list = useBlockMessage(`day-list-message-${day.id ?? ''}`)
  const deletion = useBlockMessage(`day-delete-message-${day.id ?? ''}`)

  const prescriptions = day.prescriptions ?? []

  /**
   * Move one row one place, by sending the whole list.
   *
   * #28 takes the day's complete prescription id list and rewrites positions 1..N in one
   * transaction; anything partial — a subset, a duplicate, an id from another day — is a 400
   * as a whole. So "move up" is not a request about one row, it is the entire order restated
   * with two entries swapped. That is the trade api.md made when it rejected fractional
   * positions: every reorder is a bigger request, and no reorder can leave the day in a state
   * where two prescriptions claim the same slot.
   *
   * Sent before the list moves on screen, rather than moved optimistically and rolled back.
   * There is no revert path to get wrong, and a reorder that appears to work and silently
   * did not is the failure worth avoiding on a screen whose output another person trains from.
   */
  async function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (reordering || day.id === undefined || target < 0 || target >= prescriptions.length) {
      return
    }

    const reordered = [...prescriptions]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(target, 0, moved)

    const orderedIds = reordered
      .map((prescription) => prescription.id)
      .filter((id): id is string => id !== undefined)
    if (orderedIds.length !== reordered.length) {
      // A row with no id cannot be named in the list, and a list missing one is a 400. Nothing
      // sensible to send, so nothing is sent.
      return
    }

    setReordering(true)
    // Reordering is an action in this block, so it takes the slot — which is what clears a
    // "Bench Press removed from this day" receipt the trainer has moved on from.
    list.clear()
    try {
      await reorderDayExercises(day.id, orderedIds)
      // 204, so the new positions are applied here. Renumbered 1..N to match what the server
      // just wrote, rather than carrying the old numbers into a new order.
      onChanged({
        ...day,
        prescriptions: reordered.map((prescription, position) => ({ ...prescription, position: position + 1 })),
      })
    } catch (caught) {
      // 'day': the reorder is a write to the day, so a 404 means the day is gone rather than
      // any one exercise. A rejected id inside the list comes back as its own code.
      list.fail(messageFor(caught, 'day'))
    } finally {
      setReordering(false)
    }
  }

  async function saveName(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || day.id === undefined) {
      return
    }

    // Mirrors #28's own check. Its message says "title cannot be blank", which is true and
    // says nothing about which of several days it means.
    if (title.trim() === '') {
      rename.fail('A day needs a name.')
      return
    }

    setSaving(true)
    rename.clear()
    try {
      const updated = await updateDay(day.id, { title: title.trim() })
      onChanged({ ...day, title: updated.title })
      rename.done('Name saved.')
    } catch (caught) {
      rename.fail(messageFor(caught, 'day'))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (deleting || day.id === undefined) {
      return
    }

    setDeleting(true)
    try {
      await deleteDay(day.id)
      onDeleted(day.title ?? 'That day')
    } catch (caught) {
      // Its own block, not the rename form's. A failed delete used to be written into the rename
      // error, which renders at the top of the card — so the one message about a control at the
      // bottom of the day appeared a whole card away from it, which is the exact defect
      // DESIGN.md §Messages placement was written against.
      deletion.fail(messageFor(caught, 'day'))
      setDeleting(false)
    }
  }

  return (
    // p-4 below sm:. This card nests another (the prescription rows), so the two paddings
    // compound: at p-6 outside and p-4 inside, a 390px viewport was down to ~246px of usable
    // width by the time it reached a set/reps field.
    // grid gap-6, so the four blocks inside space themselves from one number instead of each
    // carrying an mt-* — which is what let the two messages here drift to mt-2 (#138).
    <li className="grid gap-6 rounded-md border border-edge p-4 sm:p-6">
      <form className="flex flex-wrap items-end gap-3" noValidate onSubmit={saveName}>
        <div className="grid gap-2">
          <label className="text-sm font-semibold text-ink" htmlFor={`day-title-${day.id}`}>
            Day name
          </label>
          {/* The message goes as soon as the trainer starts fixing what it named, same as the
              log screen's set rows. "A day needs a name" outliving the moment a name is typed
              is the same staleness the status control had. */}
          <input
            className={trainerField}
            id={`day-title-${day.id}`}
            name="title"
            onChange={(event) => {
              setTitle(event.target.value)
              // Whatever is in this block's slot describes the last save, so it goes the moment
              // the field moves — at which point it describes something that is no longer on
              // screen. Same rule the prescription rows apply, now the same line of code.
              rename.clear()
            }}
            value={title}
          />
        </div>

        {/* w-full so the panel takes its own line in this flex-wrap row, which puts it between
            the field and the submit — before the trigger, inside the trigger's container, per
            DESIGN.md §Messages (#138). It used to render after the whole form. */}
        {rename.message !== null && (
          <Message className="w-full" id={rename.id} tone={rename.message.tone}>
            {rename.message.body}
          </Message>
        )}

        {/* The submit of this form, so it takes the accent on the same rule the prescription
            rows and the two add-forms already follow: amber commits the form it sits in. It was
            the odd one out, rendering identically to the reorder arrows a few pixels below. */}
        <button
          aria-describedby={rename.describedBy}
          className={trainerPrimary}
          disabled={saving}
          type="submit"
        >
          {saving ? 'Saving' : 'Save name'}
        </button>
      </form>

      {/* The list's slot: a reorder failure, or the receipt for a prescription that was removed.
          Before the list, because both of the controls that write here — the arrows, and each
          row's Delete — are inside it. The reorder failure used to render after the list, which
          on a day of five exercises put it several hundred pixels below the arrow that caused
          it; the removal receipt has nowhere else to go at all, since the row it is about is
          gone. */}
      {list.message !== null && (
        <Message id={list.id} tone={list.message.tone}>
          {list.message.body}
        </Message>
      )}

      <ul className="grid gap-4">
        {prescriptions.length === 0 ? (
          <p className="text-base text-muted">Nothing prescribed on this day yet.</p>
        ) : (
          prescriptions.map((prescription, index) => (
            <Prescription
              canMoveDown={index < prescriptions.length - 1}
              canMoveUp={index > 0}
              clientWeightUnit={clientWeightUnit}
              key={prescription.id}
              onChanged={(next) =>
                onChanged({
                  ...day,
                  prescriptions: prescriptions.map((candidate) =>
                    candidate.id === next.id ? next : candidate,
                  ),
                })
              }
              onDeleted={() => {
                list.done(
                  `${prescription.exercise?.name ?? 'That exercise'} removed from this day. Sets your client already logged against it stay in their history.`,
                )
                onChanged({
                  ...day,
                  prescriptions: prescriptions.filter((candidate) => candidate.id !== prescription.id),
                })
              }}
              onMoveDown={() => void move(index, 1)}
              onMoveUp={() => void move(index, -1)}
              prescription={prescription}
              reordering={reordering}
            />
          ))
        )}
      </ul>

      <AddPrescription
        dayId={day.id ?? ''}
        library={library}
        onAdded={(created) => {
          // Adding is an action in the list block, so it takes the slot from whatever receipt
          // was there. The add form's own confirmation is its block's, one slot down.
          list.clear()
          onChanged({
            ...day,
            // Appended, because #28 assigns the new prescription the position after the current
            // maximum. Putting it anywhere else here would disagree with the server until the
            // next read.
            prescriptions: [...prescriptions, created],
          })
        }}
      />

      <div className="grid justify-items-start gap-2 border-t border-edge pt-4">
        {/* One slot for this cluster: the question, or the refusal that replaced it. The two
            used to render stacked, which is #141's shape in the place with the most to lose. */}
        {deletion.message !== null && (
          <Message id={deletion.id} tone={deletion.message.tone}>
            {deletion.message.body}
          </Message>
        )}

        {deletion.prompting ? (
          <div aria-labelledby={deletion.id} className="flex flex-wrap gap-2" role="group">
            <button
              aria-describedby={deletion.id}
              className={trainerDanger}
              disabled={deleting}
              onClick={() => void remove()}
              type="button"
            >
              {deleting ? 'Deleting' : 'Delete day'}
            </button>
            {/* Bordered, matching the prescription row's "Keep it". These two prompts used to
                disagree with each other: one dismissal was amber, the other was not. */}
            <button className={trainerSecondary} onClick={deletion.clear} type="button">
              Cancel
            </button>
          </div>
        ) : (
          /* #17: the delete cascades to this day's prescriptions, but logged history is
             ON DELETE SET NULL on both workout_sessions.program_day_id and
             logged_sets.program_day_exercise_id. A trainer hesitating over this button is
             usually worried about erasing what the client already did, and the honest answer is
             that they cannot. Saying so is the difference between a confident edit and a
             program nobody dares tidy up. */
          <button
            className={trainerDanger}
            onClick={() =>
              deletion.ask(
                <>
                  <p>Delete {day.title}? Its exercises go with it.</p>
                  <p className="font-normal">
                    Workouts your client already logged stay in their history. They just stop
                    pointing at this day.
                  </p>
                </>,
              )
            }
            type="button"
          >
            Delete {day.title}
          </button>
        )}
      </div>
    </li>
  )
}

// One prescription row. Every field #28 accepts except exercise_id, which is a swap and
// therefore the picker's (#54).
//
// The form sends all five fields on every save rather than only the changed ones. #28's
// convention is that a null on the wire leaves a field alone and a blank string clears it to
// NULL, so sending the whole set is what makes clearing a load or a note possible at all.
function Prescription({
  canMoveDown,
  canMoveUp,
  clientWeightUnit,
  onChanged,
  onDeleted,
  onMoveDown,
  onMoveUp,
  prescription,
  reordering,
}: {
  canMoveDown: boolean
  canMoveUp: boolean
  /** The unit this program's client reads in, for the Load field's hint only (#99). */
  clientWeightUnit: WeightUnit
  onChanged: (prescription: PrescriptionView) => void
  onDeleted: () => void
  onMoveDown: () => void
  onMoveUp: () => void
  prescription: PrescriptionView
  reordering: boolean
}) {
  const [targetSets, setTargetSets] = useState(String(prescription.targetSets ?? ''))
  const [targetReps, setTargetReps] = useState(prescription.targetReps ?? '')
  const [targetLoad, setTargetLoad] = useState(prescription.targetLoad ?? '')
  const [restSeconds, setRestSeconds] = useState(
    prescription.restSeconds == null ? '' : String(prescription.restSeconds),
  )
  const [note, setNote] = useState(prescription.note ?? '')

  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const name = prescription.exercise?.name ?? 'Exercise'

  // The block this row is. #141: `confirming` and `saved` used to be two booleans with nothing
  // holding them apart, which is how a delete prompt and a "Saved." ended up stacked — the
  // trainer opened the prompt, pressed Save instead of answering it, and the row said both
  // things at once. There is one slot now and the prompt lives in it, so arming the row and
  // confirming a save are the same piece of state and cannot both be true.
  //
  // Per-row id, because a day renders one of these per prescription and a shared one would
  // point every row's controls at whichever rendered first (#138).
  const block = useBlockMessage(`prescription-message-${prescription.id ?? name}`)

  // Every note in this slot describes the last thing that happened here, so all of them go the
  // moment a field moves. That now includes an unanswered delete prompt: editing the row is an
  // action, and the question is moot once the trainer has done something else with it.
  const edited = block.clear

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || prescription.id === undefined) {
      return
    }

    const sets = Number.parseInt(targetSets.trim(), 10)
    if (!Number.isInteger(sets) || sets <= 0) {
      block.fail('Sets must be a whole number above zero.')
      return
    }

    if (targetReps.trim() === '') {
      block.fail('Reps are required. Anything goes: 8–10, AMRAP, RPE 8.')
      return
    }

    const rest = restSeconds.trim()
    const restValue = rest === '' ? null : Number.parseInt(rest, 10)
    if (restValue !== null && (!Number.isInteger(restValue) || restValue <= 0)) {
      block.fail('Rest must be a whole number of seconds, or empty.')
      return
    }

    // Structural only, on both free-text fields — see lib/prescriptionText.ts for exactly where
    // the line is drawn and why it is not further out. Reps takes the same class of value as
    // Load (database.md: "8–10", "AMRAP", "5/3/1") and had the same exposure. Neither is parsed
    // or converted; this refuses what cannot be a phrase, not what it cannot understand.
    //
    // The API runs the identical rules against the identical corpus, so this is the immediate
    // answer rather than the only one.
    const textProblem =
      checkPrescriptionText(targetReps, 'Reps') ?? checkPrescriptionText(targetLoad, 'Load')
    if (textProblem !== null) {
      block.fail(textProblem)
      return
    }

    setSaving(true)
    block.clear()
    try {
      const updated = await updatePrescription(prescription.id, {
        targetSets: sets,
        targetReps: targetReps.trim(),
        // #145: an emptied field is null on the wire and the server clears it. restSeconds was
        // already being sent this way and was silently ignored — emptying the rest interval put
        // the old value straight back, with no error and nothing to explain it.
        targetLoad: orNull(targetLoad),
        restSeconds: restValue,
        note: orNull(note),
      })

      onChanged({
        ...prescription,
        targetSets: updated.targetSets,
        targetReps: updated.targetReps,
        targetLoad: updated.targetLoad,
        restSeconds: updated.restSeconds,
        note: updated.note,
      })
      block.done('Saved.')
    } catch (caught) {
      block.fail(messageFor(caught, 'prescription'))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (deleting || prescription.id === undefined) {
      return
    }

    setDeleting(true)
    try {
      await deletePrescription(prescription.id)
      // The row unmounts, so the confirmation is the day's (see Day's `list` block). Nothing is
      // written into this slot on the way out — there would be nothing left to render it.
      onDeleted()
    } catch (caught) {
      // Replaces the prompt rather than sitting under it. The block disarms with it: a
      // destructive control that stays armed through a failure is one stray tap from firing on
      // a state the trainer has stopped looking at, and re-arming is the same two taps it was
      // the first time.
      block.fail(messageFor(caught, 'prescription'))
      setDeleting(false)
    }
  }

  return (
    <li className="rounded-sm border border-edge bg-surface-sunk p-4">
      <div className="flex items-baseline justify-between gap-4">
        {/* min-w-0 so the name yields to the arrows rather than pushing them off the card: a
            flex item's default minimum is min-content, which for an unbroken exercise name is
            the whole word. The arrows keep shrink-0 — they are 44px targets and there is
            nothing in them to compress — which is exactly why this side has to give. */}
        <h3 className="min-w-0 text-base font-semibold wrap-break-word text-ink-bold">{name}</h3>

        {/* Buttons, not drag. ui-ux.md calls buttons acceptable in v1 and drag polish, and the
            trade is real: a keyboard user gets the same two controls a mouse user does, and
            neither depends on a pointer gesture that has to be re-implemented for touch.

            The labels name the exercise because a day of five rows otherwise offers ten
            controls all called "Move up", and a screen reader moving through them has no way
            to tell which row it is on.

            Bordered and quiet on purpose (#132): reordering rearranges what is already there
            and writes nothing new, and a day of five rows carries ten of these. Ten accented
            arrows would be most of the colour on the screen. */}
        <div className="flex shrink-0 gap-1">
          <button
            aria-label={`Move ${name} up`}
            className={trainerSecondary}
            disabled={!canMoveUp || reordering}
            onClick={onMoveUp}
            type="button"
          >
            <span aria-hidden="true">↑</span>
          </button>
          <button
            aria-label={`Move ${name} down`}
            className={trainerSecondary}
            disabled={!canMoveDown || reordering}
            onClick={onMoveDown}
            type="button"
          >
            <span aria-hidden="true">↓</span>
          </button>
        </div>
      </div>

      <form className="mt-3 grid gap-3" noValidate onSubmit={save}>
        {/* items-start, because one field now carries a hint and the rest do not. A flex row
            defaults to `align-items: stretch`, so the short fields were being stretched to the
            tall one's height — and each Field is a grid of auto rows, which under the resulting
            `align-content: normal` stretch made their labels and inputs grow with it. The
            inputs stopped sharing a baseline the moment the hint appeared. */}
        <div className="flex flex-wrap items-start gap-3">
          <Field label="Sets" name={`sets-${prescription.id}`}>
            <input
              className={`w-20 ${trainerField}`}
              id={`sets-${prescription.id}`}
              inputMode="numeric"
              min={1}
              name="targetSets"
              onChange={(event) => {
                setTargetSets(event.target.value)
                edited()
              }}
              type="number"
              value={targetSets}
            />
          </Field>

          {/* Text, not a number. database.md: "8–10", "AMRAP", "RPE 8", "5/3/1" are real
              prescriptions, and a numeric input would refuse every one of them. */}
          <Field label="Reps" name={`reps-${prescription.id}`}>
            <input
              className={`w-32 ${trainerField}`}
              id={`reps-${prescription.id}`}
              name="targetReps"
              onChange={(event) => {
                setTargetReps(event.target.value)
                edited()
              }}
              placeholder="8–10"
              type="text"
              value={targetReps}
            />
          </Field>

          {/* Also text, and for the same reason: "70 kg", "bodyweight", "80% 1RM". */}
          {/* The hint is the whole of #99's answer for prescribed loads. target_load is free
              text and is never converted — see the module comment — so the only thing standing
              between "70 kg" and a client who reads in pounds is telling the trainer which unit
              they read in, at the moment they are typing it. The placeholder follows the same
              unit so the two never disagree. */}
          <Field
            // Short, because it wraps inside a 128px field. It still has to carry both facts:
            // that this is verbatim, and which unit the client reads.
            hint={`Free text, as typed. They read in ${unitLabel(clientWeightUnit)}.`}
            label="Load"
            name={`load-${prescription.id}`}
          >
            <input
              aria-describedby={`load-${prescription.id}-hint`}
              className={`w-32 ${trainerField}`}
              id={`load-${prescription.id}`}
              name="targetLoad"
              onChange={(event) => {
                setTargetLoad(event.target.value)
                edited()
              }}
              placeholder={clientWeightUnit === 'kg' ? '70 kg' : '155 lbs'}
              type="text"
              value={targetLoad}
            />
          </Field>

          {/* Genuinely a number, so it gets a number input. */}
          <Field label="Rest (seconds)" name={`rest-${prescription.id}`}>
            <input
              className={`w-28 ${trainerField}`}
              id={`rest-${prescription.id}`}
              inputMode="numeric"
              min={1}
              name="restSeconds"
              onChange={(event) => {
                setRestSeconds(event.target.value)
                edited()
              }}
              type="number"
              value={restSeconds}
            />
          </Field>
        </div>

        <Field label="Note" name={`note-${prescription.id}`}>
          <input
            className={`w-full ${trainerField}`}
            id={`note-${prescription.id}`}
            name="note"
            onChange={(event) => {
              setNote(event.target.value)
              edited()
            }}
            placeholder="Brace before you unrack."
            type="text"
            value={note}
          />
        </Field>

        {/* One slot, one message. The failure, the confirmation and the delete prompt were three
            renders guarded by three booleans, and #141 is what that cost: "Saved." on top of a
            still-open "Delete Back Squat from this day?". There is nothing to guard now. */}
        {block.message !== null && (
          <Message id={block.id} tone={block.message.tone}>
            {block.message.body}
          </Message>
        )}

        {/* flex-wrap, found by the 390px pass. Armed, this row is [Save][Delete {name}][Keep it],
            and the middle label carries a trainer-supplied exercise name. This card is nested
            inside the day's, so both p-4 paddings come off the viewport: 390px leaves about
            278px here, and those three buttons are about 298px with "Back Squat" in the middle
            — a shorter name than plenty of real ones. It overflowed rather than wrapping,
            because nothing here ever narrowed it. Same fix and same cause as #135's `shrink-0`
            finding on the library rows. */}
        <div className="flex flex-wrap gap-2">
          <button
            aria-describedby={block.describedBy}
            className={trainerPrimary}
            disabled={saving}
            type="submit"
          >
            {saving ? 'Saving' : 'Save'}
          </button>

          {/* Read off the slot, not off a boolean beside it. This is the mechanism: the row is
              armed exactly while the question is the thing in the slot, so a save that puts a
              confirmation there disarms the row as it answers it. */}
          {block.prompting ? (
            <>
              <button
                aria-describedby={block.id}
                className={trainerDanger}
                disabled={deleting}
                onClick={() => void remove()}
                type="button"
              >
                {deleting ? 'Deleting' : `Delete ${name}`}
              </button>
              {/* Dismissal writes nothing into the slot: cancelling a question needs no receipt,
                  and "Cancelled." would be a confirmation of not having done anything. */}
              <button className={trainerSecondary} onClick={block.clear} type="button">
                Keep it
              </button>
            </>
          ) : (
            /* --danger, like the day delete above it. This one was bordered neutral, so the
               control that removes an exercise from a client's program looked exactly like the
               Save beside it minus the amber.

               The prompt, which did not exist as a question at all before #140: this row asked
               for a delete by swapping one button for two and putting the reassurance *after*
               the button row as muted body text. Same reassurance as the day delete, and the
               same reason (#17): the client's logged sets are ON DELETE SET NULL against this
               row, so they survive keyed by the exercise itself. */
            <button
              className={trainerDanger}
              onClick={() =>
                block.ask(
                  <>
                    <p>Delete {name} from this day?</p>
                    <p className="font-normal">
                      Sets your client already logged against {name} stay in their history.
                    </p>
                  </>,
                )
              }
              type="button"
            >
              Delete
            </button>
          )}
        </div>
      </form>
    </li>
  )
}

/**
 * The picker (#54), and the smallest form that satisfies POST /api/days/:id/exercises.
 *
 * Three fields, because three is what the endpoint requires: exercise_id, target_sets, and
 * target_reps. Load, rest and note are optional there and are left to the row editor rather
 * than duplicated here — the row appears directly below with every field on it, so a second
 * copy of that form would be two places to keep in step for no gain.
 */
function AddPrescription({
  dayId,
  library,
  onAdded,
}: {
  dayId: string
  library: ExerciseResponse[]
  onAdded: (prescription: PrescriptionView) => void
}) {
  const [exerciseId, setExerciseId] = useState('')
  // Three is the overwhelmingly common answer and the field is required, so defaulting it
  // saves typing the same digit on every row. It is a starting value, not a policy.
  const [targetSets, setTargetSets] = useState('3')
  const [targetReps, setTargetReps] = useState('')
  const [saving, setSaving] = useState(false)

  const block = useBlockMessage(`add-exercise-message-${dayId}`)

  const edited = block.clear

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) {
      return
    }

    if (exerciseId === '') {
      block.fail('Pick an exercise.')
      return
    }

    const sets = Number.parseInt(targetSets.trim(), 10)
    if (!Number.isInteger(sets) || sets <= 0) {
      block.fail('Sets must be a whole number above zero.')
      return
    }

    if (targetReps.trim() === '') {
      block.fail('Reps are required. Anything goes: 8–10, AMRAP, RPE 8.')
      return
    }

    // The add form has no Load field — that is the row editor's — so Reps is the only free text
    // here. Same rules, same module, same corpus as the API's.
    const textProblem = checkPrescriptionText(targetReps, 'Reps')
    if (textProblem !== null) {
      block.fail(textProblem)
      return
    }

    setSaving(true)
    block.clear()
    try {
      const created = await createPrescription(dayId, {
        exerciseId,
        targetSets: sets,
        targetReps: targetReps.trim(),
      })

      // The create response is a PrescriptionResponse — it carries exercise_id but not the
      // exercise itself, while the tree the screen is holding carries the whole thing. The
      // name is filled in from the library rather than left blank until a reload, since the
      // library is the same list the choice was just made from.
      const exercise = library.find((candidate) => candidate.id === exerciseId)
      onAdded({
        id: created.id,
        position: created.position,
        targetSets: created.targetSets,
        targetReps: created.targetReps,
        targetLoad: created.targetLoad,
        restSeconds: created.restSeconds,
        note: created.note,
        exercise: {
          id: exerciseId,
          name: exercise?.name ?? 'Exercise',
          videoUrl: exercise?.videoUrl ?? null,
          cues: exercise?.cues ?? null,
        },
      })

      block.done(`${exercise?.name ?? 'Exercise'} added to this day.`)
      setExerciseId('')
      setTargetReps('')
      setTargetSets('3')
    } catch (caught) {
      // 400 unknown_exercise is reachable even though the picker only offers active exercises:
      // the trainer may have retired one in another tab since this screen loaded. This is the
      // case the copy map exists for. The server can only say "Unknown exercise_id." because it
      // has no idea a stale picker offered it; the SPA drew that list, so the SPA is the layer
      // that can say the library moved on and a reload will show it.
      block.fail(messageFor(caught, 'prescription'))
    } finally {
      setSaving(false)
    }
  }

  if (library.length === 0) {
    // Nothing to pick, and now somewhere to send them: #55 built the library screen this used to
    // only be able to describe. A dead end on the one screen where a trainer discovers they have
    // no exercises is the worst place to leave one.
    return (
      <div className="mt-6 border-t border-edge pt-4">
        <p className="text-sm text-muted">
          Your exercise library is empty, so there is nothing to add yet.{' '}
          {/* A link inside a sentence, and the one place on these four screens where that is
              genuinely what it is: it goes somewhere, mid-prose, and a button in the middle of
              a paragraph would be the wrong object. Inherits the paragraph's size and --muted,
              which is why trainerLink sets neither. */}
          <Link className={trainerLink} to="/exercises">
            Add an exercise
          </Link>{' '}
          and then prescribe it here.
        </p>
      </div>
    )
  }

  return (
    <form className="mt-6 flex flex-wrap items-end gap-3 border-t border-edge pt-4" noValidate onSubmit={onSubmit}>
      <div className="grid gap-1">
        <label className="text-xs text-muted" htmlFor={`add-exercise-${dayId}`}>
          Exercise
        </label>
        {/* Only active exercises are options. #26 soft-deletes and the library route returns
            retired rows too, but #28 refuses one on a new prescription — an option that is
            always a 400 is not a choice, it is a trap. */}
        <select
          className={trainerField}
          id={`add-exercise-${dayId}`}
          name="exerciseId"
          onChange={(event) => {
            setExerciseId(event.target.value)
            edited()
          }}
          value={exerciseId}
        >
          <option value="">Choose one</option>
          {library.map((exercise) => (
            <option key={exercise.id} value={exercise.id}>
              {exercise.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-1">
        <label className="text-xs text-muted" htmlFor={`add-sets-${dayId}`}>
          Sets
        </label>
        <input
          className={`w-20 ${trainerField}`}
          id={`add-sets-${dayId}`}
          inputMode="numeric"
          min={1}
          name="targetSets"
          onChange={(event) => {
            setTargetSets(event.target.value)
            edited()
          }}
          type="number"
          value={targetSets}
        />
      </div>

      {/* Text, for the same reason the row editor's is (database.md). */}
      <div className="grid gap-1">
        <label className="text-xs text-muted" htmlFor={`add-reps-${dayId}`}>
          Reps
        </label>
        <input
          className={`w-32 ${trainerField}`}
          id={`add-reps-${dayId}`}
          name="targetReps"
          onChange={(event) => {
            setTargetReps(event.target.value)
            edited()
          }}
          placeholder="8–10"
          type="text"
          value={targetReps}
        />
      </div>

      {/* Before the trigger, which it was not. This form and AddDay below were the last two
          sites still rendering their message *after* the submit — #138 moved the other eighteen
          and these two were missed because in a `flex-wrap` row "after" and "below" look
          identical until you read the DOM. `w-full` is what puts the panel on its own line, so
          it lands between the fields and the button rather than beside them. */}
      {block.message !== null && (
        <Message className="w-full" id={block.id} tone={block.message.tone}>
          {block.message.body}
        </Message>
      )}

      <button
        aria-describedby={block.describedBy}
        className={trainerPrimary}
        disabled={saving}
        type="submit"
      >
        {saving ? 'Adding' : 'Add exercise'}
      </button>
    </form>
  )
}

function AddDay({
  onAdded,
  programId,
}: {
  onAdded: (day: { id?: string; title?: string | null; position?: number }) => void
  programId: string
}) {
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)

  const block = useBlockMessage('add-day-message')

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) {
      return
    }

    if (title.trim() === '') {
      block.fail('A day needs a name.')
      return
    }

    const name = title.trim()

    setSaving(true)
    block.clear()
    try {
      onAdded(await createDay(programId, { title: name }))
      setTitle('')
      block.done(`${name} added.`)
    } catch (caught) {
      // 'program': the day does not exist yet, so a 404 is about the program being written to.
      block.fail(messageFor(caught, 'program'))
    } finally {
      setSaving(false)
    }
  }

  // No mt-6: the Days section is a grid now and spaces this like everything else in it.
  return (
    <form className="flex flex-wrap items-end gap-3" noValidate onSubmit={onSubmit}>
      <div className="grid gap-2">
        <label className="text-sm font-semibold text-ink" htmlFor="new-day-title">
          Add a day
        </label>
        <input
          className={trainerField}
          id="new-day-title"
          name="title"
          onChange={(event) => {
            setTitle(event.target.value)
            block.clear()
          }}
          placeholder="Lower"
          value={title}
        />
      </div>

      {/* Before the trigger. See AddPrescription for why these two were the survivors.

          The new day appears at the bottom of a list the trainer may have scrolled past, and the
          field clears itself, so "did that work" was a genuine question rather than a formality. */}
      {block.message !== null && (
        <Message className="w-full" id={block.id} tone={block.message.tone}>
          {block.message.body}
        </Message>
      )}

      <button
        aria-describedby={block.describedBy}
        className={trainerPrimary}
        disabled={saving}
        type="submit"
      >
        {saving ? 'Adding' : 'Add day'}
      </button>
    </form>
  )
}

function Field({
  children,
  hint,
  label,
  name,
}: {
  children: React.ReactNode
  /** Optional helper text under the control, wired to it with aria-describedby. */
  hint?: string
  label: string
  name: string
}) {
  const hintId = `${name}-hint`

  return (
    <div className="grid gap-1">
      <label className="text-xs text-muted" htmlFor={name}>
        {label}
      </label>
      {children}
      {/* `w-0 min-w-full` is the whole fix for the alignment bug, and it is worth explaining
          because it looks like a contradiction.

          This div is a grid, and its column is sized to the max-content of its items. A hint
          with any intrinsic width joins that calculation and wins — the previous `max-w-48`
          made the Load field 192px wide against a 128px input, which shoved the Rest field
          right and re-wrapped the whole row. `w-0` takes the hint out of the sizing pass
          entirely, so the column is still exactly as wide as the label and the input; then
          `min-w-full` lets it fill that column and wrap inside it.

          The result is a hint that hangs below its own field and can never move it, at any
          width and at any copy length. No per-field width has to be passed in and kept in step
          with the input's. */}
      {hint !== undefined && (
        <p className="w-0 min-w-full text-xs text-muted" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  )
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
