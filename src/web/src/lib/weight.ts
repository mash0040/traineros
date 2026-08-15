// The unit boundary (#99). Everything that converts between what is stored and what a person
// reads or types goes through here, and nothing else in the SPA knows the factor.
//
// ── Storage is canonical, always ───────────────────────────────────────────────────────────
// logged_sets.weight_kg is kilograms whatever the client's setting says (database.md §users).
// So component state stays in kilograms too — SavedSet.weightKg, lib/history.ts, the values
// this app compares in /api/me/last — and conversion happens only in a leaf render or at a
// submit. A screen that converted early would put two units into one state tree and lose track
// of which was which, which is the per-set ambiguity the schema exists to prevent.
//
// The one exception is the pending input string, which is display-unit by definition: it is
// what someone is typing.
//
// ── Why lb → kg is lossless ────────────────────────────────────────────────────────────────
// 1 lb = 0.45359237 kg *exactly*, by the 1959 international agreement. That is a terminating
// decimal, so multiplying by it introduces no error in decimal arithmetic, and weight_kg is
// PostgreSQL `numeric` with no declared precision — arbitrary precision, so nothing is
// truncated on the way in. 185 lb stores as exactly 83.91458845 kg and divides back to exactly
// 185. Only kg → lb repeats, and only for values someone actually typed in kilograms.
export const KG_PER_LB = 0.45359237

export type WeightUnit = 'kg' | 'lb'

/**
 * The unit a `MeResponse` names, defaulted for the null the generated client insists on.
 *
 * types.gen.ts types every string field as `string | null | undefined` because the OpenAPI
 * document does, so the narrowing has to happen somewhere. Here, once, rather than at each of
 * the eight call sites.
 */
export function unitOf(value: string | null | undefined): WeightUnit {
  return value === 'kg' ? 'kg' : 'lb'
}

/**
 * Display precision: 2 decimal places, trailing zeros stripped.
 *
 * **Not plate increments**, which is where #99's AC started and why this comment is long.
 * Snapping a displayed weight to 2.5 lb / 1 kg changes numbers people actually lift: 87.5 kg is
 * a standard load (2.5 kg jumps come from 1.25 kg pairs) and would render as 88, and 183 lb off
 * a dumbbell rack or a machine stack would render as 182.5. A logged set is a record of what
 * happened; rounding it to a grid rewrites the record, and because the next set pre-fills from
 * it, the rewrite propagates.
 *
 * Two decimals never lies and needs no branch. In the common case — everything typed in the
 * client's own unit — it is the identity, because nobody types three decimals. The extra digit
 * only ever surfaces on a value entered in the *other* unit (100 kg read as 220.46 lb), which
 * is exactly the case where the number genuinely is not round.
 *
 * Plate increments do have a home: proposing the next weight to load. That is not this.
 */
const DISPLAY_DECIMALS = 2

/**
 * Send precision: 9 decimal places.
 *
 * Only ever a float64 hygiene measure, never a rounding decision. `185 * 0.45359237` evaluates
 * to 83.91458845000001 in JS, and letting that reach a `numeric` column would put a digit in
 * the database that no one meant. 9 dp is the smallest fixed precision at which the lb grid is
 * exact — 0.1 lb is 0.045359237 kg, eight decimals — so any pound value anyone types converts
 * losslessly, and it sits a thousand times below a milligram.
 */
const SEND_DECIMALS = 9

function round(value: number, decimals: number): number {
  // Scale-round-unscale rather than toFixed+parseFloat: one allocation fewer, and toFixed's
  // half-away-from-zero on binary floats is the same approximation anyway at these magnitudes.
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * Stored kilograms → the number to show, in the reader's unit.
 *
 * `null` is bodyweight (weight_kg NULL, database.md) and stays null: there is nothing to
 * convert and the caller renders NO_VALUE.
 */
export function toDisplay(weightKg: number | null | undefined, unit: WeightUnit): number | null {
  if (weightKg === null || weightKg === undefined) {
    return null
  }

  return round(unit === 'kg' ? weightKg : weightKg / KG_PER_LB, DISPLAY_DECIMALS)
}

/** The same value as a string, which is what an input's `value` and a rendered cell both want. */
export function toDisplayText(weightKg: number | null | undefined, unit: WeightUnit): string {
  const value = toDisplay(weightKg, unit)
  // String() already drops trailing zeros — 185.00 is 185, 220.50 is 220.5 — which is the
  // "strip trailing zeros" half of the rule, for free and without a format string.
  return value === null ? '' : String(value)
}

/** What someone typed → canonical kilograms for the wire. */
export function toKg(value: number, unit: WeightUnit): number {
  return round(unit === 'kg' ? value : value * KG_PER_LB, SEND_DECIMALS)
}

/**
 * The column header, the toggle's labels, the suffix in a sentence.
 *
 * "lbs", not "lb" — this is the only place the two diverge, and they diverge on purpose. The
 * stored value, the wire value and the enum are all `'lb'`, because that is the unit symbol and
 * a database column should carry the symbol. What a person reads is "lbs", because that is what
 * is painted on the plates and what anyone in a gym says. Kilograms are "kg" in both, since
 * nobody writes "kgs".
 *
 * So: never render a WeightUnit directly. Render this.
 */
export function unitLabel(unit: WeightUnit): string {
  return unit === 'kg' ? 'kg' : 'lbs'
}

/**
 * The spoken form, for aria strings.
 *
 * Screen readers render "kg" unpredictably — "kay gee", "kilogram", or the letters — and these
 * strings are read mid-set by someone who cannot look at the screen. Spelled out, always.
 */
export function spokenUnit(unit: WeightUnit): string {
  return unit === 'kg' ? 'kilograms' : 'pounds'
}
