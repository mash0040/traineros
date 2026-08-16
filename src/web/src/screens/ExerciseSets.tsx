import type { HistoryExerciseGroup } from '../lib/history'
import { spokenUnit, toDisplay, unitLabel, type WeightUnit } from '../lib/weight'

// One exercise's recorded sets, shared by the two screens that show them: the client's own
// History (#48) and the trainer's view of a client's log (#142).
//
// One component, not two, for the reason ProgramTreeViews.cs gives on the API side: these are
// the same logged_sets rows read through two scopes, and the unit rules they carry — which unit
// label to show, when to omit it, how to speak it — would otherwise be in two places to keep in
// step. #99 put those rules in three files already; a fourth and fifth copy is where they start
// to disagree.
//
// What is deliberately *not* shared is the container. The client's History wraps these in a
// bordered card (DESIGN.md names a session in history as one of the few places a card is
// warranted); the trainer's sits in a divide-y row inside a max-w-5xl column. Forcing one
// container on both would couple two screens' layouts for no benefit — the part that is
// genuinely identical is this list, and it stops here.
//
// ── Recorded values, one rank ──────────────────────────────────────────────────────────────
// DESIGN.md's three-number hierarchy governs the log row, where today's inputs outrank last
// time which outranks the prescription. None of those roles exist here: there are no inputs and
// no last-time column, just what happened. So there is one rank — the weight and reps at
// --text-base / 600 / --ink-bold with tabular-nums so successive sets line up — and a set
// number in --muted to count them off.
export function ExerciseSets({
  exercise,
  idPrefix,
  unit,
}: {
  exercise: HistoryExerciseGroup
  /**
   * Namespaces the heading id. Both screens can render the same exercise inside different
   * sessions on one page, and a duplicate id would point every set list's aria-labelledby at
   * whichever heading rendered first.
   */
  idPrefix: string
  unit: WeightUnit
}) {
  // Bodyweight sets carry no unit, so a group of nothing but them gets no label — "lbs" over a
  // column of "8 reps" would be a unit for a number that is not there.
  const anyWeighted = exercise.sets.some((set) => set.weightKg !== null)
  const headingId = `${idPrefix}-exercise-${exercise.id}`

  return (
    <div className="grid gap-2">
      {/* The unit, named once per exercise rather than suffixed onto every row. History has no
          column header, so the exercise heading is the nearest thing that plays the part the
          log screen's header row plays — where DESIGN.md §Log row says the unit lives and is
          "never repeated per set row".

          The per-set aria-label spells it out on every row regardless (see spokenSet): a screen
          reader has no column header to carry it, so there the repetition is the only option. */}
      <div className="flex items-baseline justify-between gap-3">
        {/* min-w-0 and wrap-break-word because this heading is a flex item. A flex item's
            default minimum is min-content, which for an unbroken exercise name is the whole
            word. Same pair the exercise library applies to its own row headings. */}
        <h3
          className="min-w-0 text-base font-semibold wrap-break-word text-ink-bold"
          id={headingId}
        >
          {exercise.name}
        </h3>
        {anyWeighted && <span className="shrink-0 text-xs text-muted">{unitLabel(unit)}</span>}
      </div>

      {/* Labelled by its own heading. A session holds several of these lists back to back, so an
          unlabelled one leaves a screen reader to infer which exercise's sets it has landed in
          from whatever it heard last. It also gives the group a name to scope to that does not
          depend on the markup around it. */}
      <ul aria-labelledby={headingId} className="grid gap-1">
        {exercise.sets.map((set) => (
          // Labelled, with the cells hidden behind it, for the same reason the log screen's
          // saved row is: the columns are laid out by the grid and nothing separates them in
          // the text stream, so read cell by cell "1" and "100 × 5" run together into "1100".
          <li
            aria-label={spokenSet(set, unit)}
            className="grid grid-cols-[2rem_1fr] items-baseline gap-3"
            key={set.id}
          >
            <span aria-hidden="true" className="text-sm text-muted tabular-nums">
              {set.setNumber}
            </span>
            <span aria-hidden="true" className="text-base font-semibold text-ink-bold tabular-nums">
              {set.weightKg === null ? (
                // Bodyweight (weight_kg NULL, database.md). Named rather than shown as
                // "– × 8", which reads as a number that went missing.
                `${set.reps} reps`
              ) : (
                <>
                  {/* The display boundary (#99): stored kilograms, read in the client's unit. */}
                  {toDisplay(set.weightKg, unit)}
                  <span className="text-muted"> × </span>
                  {set.reps}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * "Set 2, 102.5 kilograms by 5 reps".
 *
 * The unit is spelled out because screen readers render "kg" and "lbs" unpredictably, and this
 * is the only channel for someone who cannot see the heading that carries the short form.
 */
export function spokenSet(
  set: { setNumber: number; weightKg: number | null; reps: number },
  unit: WeightUnit,
): string {
  return set.weightKg === null
    ? `Set ${set.setNumber}, ${set.reps} reps`
    : `Set ${set.setNumber}, ${toDisplay(set.weightKg, unit)} ${spokenUnit(unit)} by ${set.reps} reps`
}
