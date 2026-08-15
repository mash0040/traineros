import { describe, expect, it } from 'vitest'

import { KG_PER_LB, spokenUnit, toDisplay, toDisplayText, toKg, unitLabel, unitOf } from './weight'

// #99. The rounding rule is the decision this ticket is least able to change later — once
// clients have logged against it, the stored numbers are the stored numbers — so it is pinned
// here rather than left to the screens that consume it.
describe('weight', () => {
  describe('the conversion is exact in the direction that matters', () => {
    it('converts pounds to kilograms with no error at all', () => {
      // 1 lb = 0.45359237 kg exactly (1959 international pound), and that is a terminating
      // decimal, so the product is exact in decimal. This is why nothing is rounded on the way
      // into a `numeric` column with no declared precision.
      expect(toKg(185, 'lb')).toBe(83.91458845)
      expect(toKg(45, 'lb')).toBe(20.41165665)
      expect(toKg(2.5, 'lb')).toBe(1.133980925)
    })

    it('leaves kilograms alone', () => {
      expect(toKg(100, 'kg')).toBe(100)
      expect(toKg(87.5, 'kg')).toBe(87.5)
    })

    it('keeps the 9-decimal send precision below anything a scale could measure', () => {
      // The bound this precision exists to respect: 0.1 lb is eight decimals of a kilogram, so
      // nine captures every pound value anyone types. It is a float64 hygiene measure, never a
      // rounding decision.
      expect(toKg(0.1, 'lb')).toBe(0.045359237)
      expect(KG_PER_LB).toBe(0.45359237)
    })
  })

  describe('display rounds to 2 dp and never to a plate grid', () => {
    it('does not rewrite a weight the client actually lifted', () => {
      // The counterexample that decided the rule against plate increments: 87.5 kg is a
      // standard load (2.5 kg jumps come from 1.25 kg pairs) and a 1 kg grid would show 88.
      expect(toDisplay(87.5, 'kg')).toBe(87.5)
      // And on the other side: 183 lb comes off a dumbbell rack or a machine stack all the
      // time, and a 2.5 lb grid would show 182.5.
      expect(toDisplayText(toKg(183, 'lb'), 'lb')).toBe('183')
    })

    it('is the identity for anything typed in the reader’s own unit', () => {
      for (const value of [45, 92.5, 100, 137.5, 183, 185, 225]) {
        expect(toDisplayText(toKg(value, 'lb'), 'lb')).toBe(String(value))
      }
      for (const value of [20, 60, 82.5, 87.5, 102.5, 140]) {
        expect(toDisplayText(toKg(value, 'kg'), 'kg')).toBe(String(value))
      }
    })

    it('strips trailing zeros rather than padding to a fixed width', () => {
      expect(toDisplayText(100, 'kg')).toBe('100')
      expect(toDisplayText(toKg(185, 'lb'), 'lb')).toBe('185')
      // The one case the second decimal surfaces: a value entered in the other unit, where the
      // number genuinely is not round.
      expect(toDisplayText(100, 'lb')).toBe('220.46')
    })

    it('carries bodyweight through as null in both units', () => {
      // weight_kg NULL is bodyweight (database.md); there is nothing to convert and the caller
      // renders NO_VALUE rather than a zero.
      expect(toDisplay(null, 'kg')).toBeNull()
      expect(toDisplay(null, 'lb')).toBeNull()
      expect(toDisplay(undefined, 'lb')).toBeNull()
      expect(toDisplayText(null, 'lb')).toBe('')
    })
  })

  describe('round-tripping is stable, which is what the AC asked for', () => {
    it('survives the exact journey #99 names: 185, shown as 185, edited to 190', () => {
      const stored = toKg(185, 'lb')
      expect(toDisplayText(stored, 'lb')).toBe('185')

      const edited = toKg(190, 'lb')
      expect(toDisplayText(edited, 'lb')).toBe('190')
      // No drift into the value that was not touched.
      expect(toDisplayText(stored, 'lb')).toBe('185')
    })

    it('is a fixed point under repeated pre-fill and re-save', () => {
      // The compounding case: each saved set pre-fills the next row from the stored value, so
      // a client tapping Save ten times without editing must not walk the number.
      let stored = toKg(185, 'lb')
      for (let i = 0; i < 10; i += 1) {
        const shown = toDisplayText(stored, 'lb')
        expect(shown).toBe('185')
        stored = toKg(Number(shown), 'lb')
      }
      expect(stored).toBe(83.91458845)
    })

    it('snaps a cross-unit value once and then holds', () => {
      // A value entered in kilograms, read by someone who has since switched to pounds. The
      // first re-save moves it — 100 kg is not a round number of pounds — and every save after
      // that is a no-op. One snap, then stable, which is the honest behaviour rather than a
      // number that creeps every time it is touched.
      const first = toKg(Number(toDisplayText(100, 'lb')), 'lb')
      const second = toKg(Number(toDisplayText(first, 'lb')), 'lb')
      expect(second).toBe(first)
    })
  })

  describe('unitOf narrows what the generated client hands over', () => {
    it('treats anything that is not kg as lb, including the nulls types.gen insists on', () => {
      expect(unitOf('kg')).toBe('kg')
      expect(unitOf('lb')).toBe('lb')
      expect(unitOf(null)).toBe('lb')
      expect(unitOf(undefined)).toBe('lb')
      expect(unitOf('stone')).toBe('lb')
    })
  })

  describe('spoken units', () => {
    it('spells the unit out, because screen readers render kg and lb unpredictably', () => {
      expect(spokenUnit('kg')).toBe('kilograms')
      expect(spokenUnit('lb')).toBe('pounds')
    })
  })

  describe('the display label diverges from the stored value, on purpose', () => {
    it('shows lbs while the enum stays lb', () => {
      // 'lb' is the symbol and is what the column, the wire and the enum carry. "lbs" is what
      // is painted on the plates. Nothing renders a raw WeightUnit.
      expect(unitLabel('lb')).toBe('lbs')
      expect(unitLabel('kg')).toBe('kg')
    })
  })
})
