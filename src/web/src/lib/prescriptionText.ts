// A structural sanity check for the two free-text prescription fields — target_reps and
// target_load — and deliberately not a parser (#99 follow-up).
//
// ── What database.md settled, and what it did not ──────────────────────────────────────────
// §program_day_exercises: both fields are text "on purpose" — '8–10', 'AMRAP', 'RPE 7–8',
// '100 kg', '70%' — and "parsing for analytics is a v2 problem; v1 displays them verbatim."
// That stands. Nothing here understands units, reps, or numbers; nothing converts. #99
// reaffirmed it for load specifically: a partial parser would rewrite "70 kg" and pass through
// "3×5 @ 70-80kg", leaving a client mixed units with no way to tell which had been changed,
// and a mis-parse of a prescribed load is an injury.
//
// What it did not settle is whether *anything* is refused. "70 lbsgjhm" and "AMRKJDNAK,M" both
// saved, and both reach a client as their prescription — a typo the trainer cannot see happen
// and the client cannot act on.
//
// ── Where the line is drawn ────────────────────────────────────────────────────────────────
// Four structural rules. None reads the value for meaning; each rejects only what cannot be a
// phrase anyone writes in these fields.
//
//   1. Length ≤ 40. A prescription is short.
//   2. Character set. Letters, digits, whitespace, and the punctuation programming actually
//      uses: % + - – — / . , : × @ ( ) '. Emoji, currency, control characters are not reps.
//   3. An alphabetic run of four or more letters contains a vowel. "lbsgjhm" is seven letters
//      and none of them is one.
//   4. No run of six or more consecutive consonants anywhere.
//
// Rule 4 exists because rule 3 is not enough, which is worth recording rather than quietly
// fixing: "AMRKJDNAK" *has* vowels — three A's — so rule 3 accepts it. What marks it is the
// six-consonant run MRKJDN in the middle. Rules 3 and 4 catch different shapes of mashing and
// neither subsumes the other: a four-letter vowel-less run like "bcdf" trips 3 and not 4.
//
// Six, not five, and this is the one number that took measuring. English tops out at five
// consecutive consonants — the "ngths" in "strengths" and "lengths" — so a threshold of five
// would refuse real words. Six has no English counter-example and still catches the reported
// case. False positives here reject a trainer's real prescription, which is far worse than
// letting a typo through, so the threshold is set by the worst legitimate input rather than by
// the best catch rate.
//
// What this deliberately does NOT catch: "asdfgh" has a vowel and a five-consonant run, so it
// passes. Catching it needs n-grams or a dictionary — a parser by another name — and a
// dictionary that does not know "backoffs" would start refusing real coaching language.
//
// ── One rule, two languages ────────────────────────────────────────────────────────────────
// This is mirrored in src/TrainerOS.Api/PrescriptionText.cs, because a guard that lives only in
// one browser is a property of that browser rather than of the data, and the API is what
// decides what a client is shown. There is no shared runtime between C# and TypeScript, so the
// implementation is duplicated; what stops the two drifting is not this comment but
// tests/shared/prescriptionText.cases.json, a single corpus both test suites read. Add a case
// there and both languages are held to it.

const MAX_LENGTH = 40

// The dash family is spelled out rather than ranged: an en dash appears in "8–10", and an em
// dash is banned from rendered strings by DESIGN.md but not from a trainer's keyboard.
const ALLOWED = /^[\p{L}\p{N}\s%+\-–—/.,:×@()']*$/u

/** Alphabetic runs of four or more, which are the only ones rule 3 examines. */
const LONG_LETTER_RUN = /\p{L}{4,}/gu

// y counts as a vowel in both rules. Without it "bodyweight" and "dryland" would be judged on
// their consonants.
const VOWEL = /[aeiouy]/i

/** Six or more consonants in a row. Vowels, digits, spaces and punctuation all break the run. */
const CONSONANT_RUN = /[b-df-hj-np-tv-xz]{6,}/i

/**
 * Null when the value is fine, or the sentence to show the trainer.
 *
 * `field` is the visible label — "Reps" or "Load" — so the message names what the trainer is
 * looking at rather than the wire field. The API's copy of this produces the same sentences for
 * the same reason the email rule does: whichever layer catches it, this is one mistake to them.
 *
 * An empty value is fine here. Load is optional, and Reps is required by its own check at the
 * call site — that is a different question and it already has a better-worded answer.
 */
export function checkPrescriptionText(value: string, field: 'Reps' | 'Load'): string | null {
  const text = value.trim()
  if (text === '') {
    return null
  }

  if (text.length > MAX_LENGTH) {
    return `Keep ${field.toLowerCase()} under ${MAX_LENGTH} characters.`
  }

  if (!ALLOWED.test(text)) {
    return `${field} can use letters, numbers and the usual punctuation.`
  }

  const vowelless = (text.match(LONG_LETTER_RUN) ?? []).find((run) => !VOWEL.test(run))
  if (vowelless !== undefined) {
    return unpronounceable(field, vowelless)
  }

  const mashed = CONSONANT_RUN.exec(text)
  if (mashed !== null) {
    return unpronounceable(field, mashed[0])
  }

  return null
}

// Names the run rather than the whole value, because the trainer's eye needs to land on the
// part that is wrong — in "70 lbsgjhm" the number is fine and the word is not.
function unpronounceable(field: 'Reps' | 'Load', run: string): string {
  return `“${run}” doesn’t look like a word. Check the ${field.toLowerCase()}.`
}
