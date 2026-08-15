import { describe, expect, it } from 'vitest'

import { checkPrescriptionText } from './prescriptionText'
import corpus from './prescriptionText.cases.json'

// The corpus half of this file is the point. The rule is implemented twice — here in TypeScript
// and in src/TrainerOS.Api/PrescriptionText.cs — because there is no shared runtime between the
// SPA and the API. A comment in each pointing at the other is not a guarantee that they agree;
// tests/shared/prescriptionText.cases.json is, because both suites read it and assert every
// case. A rule that drifts in one language fails a test in the other.
//
// A plain import, which is why the corpus lives beside this file rather than in a neutral
// tests/shared/. Reading it from outside the Vite root would need node's fs here, and typing
// that means adding @types/node to tsconfig.app.json — which would also let application code
// import fs into a browser bundle. The JSON's own header records the trade.
//
// It reaches no production bundle: nothing but this test imports it.

describe('checkPrescriptionText', () => {
  it('is actually reading the shared corpus', () => {
    // Otherwise an empty or mis-parsed corpus would make every case below vacuously pass, which
    // is the one way a shared fixture can fail silently.
    expect(corpus.accept.length).toBeGreaterThan(20)
    expect(corpus.reject.length).toBeGreaterThan(5)
  })

  // Both fields run the same rules, so the corpus is asserted against both. A tighter ceiling
  // on Reps was considered and rejected — see the report; if that ever changes, it changes here
  // as a decision rather than as a surprise.
  describe.each(['Reps', 'Load'] as const)('%s', (field) => {
    it.each(corpus.accept)('accepts %j', (value) => {
      expect(checkPrescriptionText(value, field)).toBeNull()
    })

    it.each(corpus.reject)('refuses %j', (value) => {
      expect(checkPrescriptionText(value, field)).not.toBeNull()
    })
  })

  describe('the message', () => {
    it('names the field the trainer is looking at', () => {
      expect(checkPrescriptionText('70 lbsgjhm', 'Reps')).toContain('reps')
      expect(checkPrescriptionText('70 lbsgjhm', 'Load')).toContain('load')
    })

    it('names the run rather than the whole value', () => {
      // In "70 lbsgjhm" the number is fine and the word is not, so the trainer's eye needs to
      // land on the part that is wrong.
      expect(checkPrescriptionText('70 lbsgjhm', 'Load')).toContain('lbsgjhm')
      expect(checkPrescriptionText('AMRKJDNAK,M', 'Load')).toContain('MRKJDN')
    })
  })

  describe('the line, stated as tests so moving it is deliberate', () => {
    it('needs both the vowel rule and the consonant-run rule', () => {
      // Neither subsumes the other, and this is the pair that took measuring. "AMRKJDNAK" HAS
      // vowels — three A's — so the vowel rule accepts it; what marks it is the six-consonant
      // run in the middle. "bcdf" is the other direction: four letters, no vowel, no six-run.
      expect(checkPrescriptionText('AMRKJDNAK', 'Reps')).not.toBeNull()
      expect(checkPrescriptionText('bcdf', 'Reps')).not.toBeNull()
    })

    it('sets the consonant threshold above the longest real English cluster', () => {
      // English tops out at five consecutive consonants. A threshold of five would refuse these,
      // and refusing a trainer's real prescription is worse than letting a typo through.
      expect(checkPrescriptionText('strengths', 'Load')).toBeNull()
      expect(checkPrescriptionText('lengths', 'Load')).toBeNull()
    })

    it('exempts runs of three letters or fewer, which is every abbreviation in the gym', () => {
      for (const value of ['RPE 8', '1RM', 'BW', 'DB 20', 'KB', 'sl']) {
        expect(checkPrescriptionText(value, 'Load')).toBeNull()
      }
    })

    it('lets pronounceable nonsense through, on purpose', () => {
      // "asdfgh" has a vowel and a five-consonant run, so it passes. Catching it needs n-grams
      // or a dictionary — a parser by another name — and a dictionary that does not know
      // "backoffs" would start refusing real coaching language.
      expect(checkPrescriptionText('asdfgh', 'Reps')).toBeNull()
    })

    it('understands nothing about the value it accepts', () => {
      // database.md's free-text decision is intact: it cannot tell a unit from a word, a
      // plausible weight from an absurd one, and it never converts.
      expect(checkPrescriptionText('70 furlongs', 'Load')).toBeNull()
      expect(checkPrescriptionText('99999 kg', 'Load')).toBeNull()
      expect(checkPrescriptionText('-5 kg', 'Load')).toBeNull()
    })
  })
})
