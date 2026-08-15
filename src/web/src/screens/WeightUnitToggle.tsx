import { useState } from 'react'

import type { MeResponse } from '../api/types.gen'
import { updateMyWeightUnit } from '../lib/api'
import { messageFor } from '../lib/apiMessages'
import { unitLabel, type WeightUnit } from '../lib/weight'
import { useBlockMessage } from './blockMessage'
import { Message } from './Message'

// #99. Where a client corrects the unit they read in — on the log screen, because that is the
// one place the question arises: it arises while looking at a number you cannot use.
//
// ── Why one toggle and not one per exercise block ──────────────────────────────────────────
// The obvious place is beside the `kg` column header, and it is the wrong place twice over.
// That header lives inside ExerciseBlock, so a six-exercise day would render six toggles all
// writing one setting — the per-row-control shape DESIGN.md §Controls rules out for the same
// reason it rules out forty edit toggles. And the header row carries aria-hidden, so a
// focusable control inside it is unreachable to a screen reader. So: one, above the first
// block, right-aligned so it still sits over the weight column and reads as belonging to it.
//
// ── Why it writes the profile rather than toggling a local view ────────────────────────────
// Unit is a stable property of a person, not a per-set choice. A local-only switch would mean
// the same client sees kilograms today and pounds tomorrow depending on a control they last
// touched on some other device, and #46's last-time comparison — the feature that beats the
// paper notebook — would be comparing numbers against a label that had moved. One write, one
// answer, everywhere they log in.
//
// ── Why it awaits rather than flipping optimistically ──────────────────────────────────────
// Gym wifi. An optimistic flip that silently reverts thirty seconds later is worse than a
// short wait: it would tell a client their unit is kilograms while the server still says
// pounds, and the next set they typed would be stored as the wrong number. The control
// disables itself in flight and the refusal lands in its own message slot.
export function WeightUnitToggle({
  onMeChanged,
  unit,
}: {
  onMeChanged: (me: MeResponse) => void
  unit: WeightUnit
}) {
  const [saving, setSaving] = useState<WeightUnit | null>(null)
  const block = useBlockMessage('weight-unit-message')

  async function choose(next: WeightUnit) {
    // Pressing the unit you are already in is a no-op, and it is also how the failure below
    // gets dismissed — the same gesture the program builder's status group uses.
    block.clear()
    if (next === unit || saving !== null) {
      return
    }

    setSaving(next)
    try {
      onMeChanged(await updateMyWeightUnit(next))
    } catch (caught) {
      block.fail(messageFor(caught, 'client'))
    } finally {
      setSaving(null)
    }
  }

  return (
    // justify-items-end so the group sits over the two input columns rather than the set
    // number. grid rather than flex because the message below it has to take the full width
    // and a flex row would put it beside the buttons.
    //
    // pr-4 matches the exercise card's own p-4, so the toggle's right edge lines up with the
    // Reps column header rather than sitting 16px outside it — without it, "right-aligned over
    // the weight column" is right-aligned over the card's border instead.
    //
    // mt-8 is the gap the exercise list used to carry, taken over rather than added to: this
    // control is what now sits below the day title. The list follows at mt-3, tight, because
    // the toggle labels the columns underneath it and belongs to them.
    <div className="mt-8 grid justify-items-end gap-2 pr-4">
      {block.message !== null && (
        <Message className="w-full" id={block.id} tone={block.message.tone}>
          {block.message.body}
        </Message>
      )}

      {/* Labelled, because two buttons reading "kg" and "lb" with nothing around them are two
          unexplained abbreviations to anyone not looking at the column they sit above. */}
      <div aria-label="Weight unit" className="flex items-center gap-2" role="group">
        <span aria-hidden="true" className="text-xs text-muted">
          Show weights in
        </span>
        {UNITS.map((candidate) => {
          const current = candidate === unit
          return (
            <button
              aria-describedby={block.describedBy}
              // aria-pressed rather than a radio group: these are two buttons that each
              // perform a write, not a form field that holds a value until submit.
              aria-pressed={current}
              className={current ? SELECTED : UNSELECTED}
              disabled={saving !== null}
              key={candidate}
              onClick={() => void choose(candidate)}
              type="button"
            >
              {saving === candidate ? 'Saving' : unitLabel(candidate)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const UNITS: WeightUnit[] = ['kg', 'lb']

// The same inverted-neutral selected state DESIGN.md §Controls defines for the program
// builder's status group, and for the same reason: selection is a strong signal carried by a
// neutral one, because amber is spent on "the thing to tap" and this row has no such thing —
// whichever unit you are in, the control that advances the screen is Save set, further down.
//
// Sized below --tap-min deliberately, and it is the only control on this screen that is. A
// 44px pair here would be a block of chrome above the first exercise on the screen DESIGN.md
// spends a whole section protecting; this is a setting a client touches once, not a control
// they hit mid-set. The tap target is still 32px tall and ~44px wide with the padding, which
// is the compromise the roster's own inline controls make below sm:.
const CHIP =
  'inline-flex min-h-8 min-w-11 items-center justify-center rounded-sm px-2 text-sm font-semibold ' +
  'disabled:text-muted'

const SELECTED = `${CHIP} border border-ink-bold bg-ink-bold text-surface enabled:hover:bg-ink`
const UNSELECTED = `${CHIP} border border-edge bg-surface text-ink enabled:hover:border-edge-strong`
