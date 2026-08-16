// "Tap a set to change it" — shown once, ever, then never again (#107).
//
// ── Why this needs storage at all ──────────────────────────────────────────────────────────
// #105 put deletion behind a reveal: tapping a saved row opens an action strip under it.
// Nothing on the row says it opens, and #107 is explicit that no permanent per-row glyph is the
// answer — DESIGN.md's decoration ban rules out putting a control on every row for an action
// taken a few times a month. So the affordance is taught once instead of decorated forever, and
// "once" has to survive the tab being evicted between sets, which is the same gym-floor failure
// workoutDraft.ts exists for.
//
// ── Why it is not a field on the draft ─────────────────────────────────────────────────────
// The draft is the in-progress workout and is cleared at Finish. This outlives every workout by
// definition: a hint that came back next Tuesday would not be a one-time hint. Separate key,
// separate lifetime, and the two are never read together.
//
// ── Not the auth exception ─────────────────────────────────────────────────────────────────
// Same reasoning workoutDraft.ts records. #42 settled that auth state comes from GET /api/me and
// never from storage, because a cached "signed in" flag outlives a revoked session. This is not
// a credential or a claim about one; it is a note-to-self about what this device has been shown,
// and the worst case if it is wrong in either direction is one line of muted text.
//
// Device-local, not per-account, and deliberately so. It records what has been *seen on this
// screen*, and the screen is the same screen whoever is holding the phone. A client with two
// devices being taught twice is the correct outcome, not a bug.

const KEY = 'traineros.saved-row-hint.v1'

/** Whether this device has already been shown the hint. Any storage failure reads as "no". */
export function rowHintDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === 'dismissed'
  } catch {
    // Private mode, disabled storage, a full quota. The hint is worth showing again far more
    // than it is worth throwing over, which is the same trade readDraft makes.
    return false
  }
}

/** Permanently, per the AC. There is no path back short of clearing site data. */
export function dismissRowHint(): void {
  try {
    localStorage.setItem(KEY, 'dismissed')
  } catch {
    // Nothing to do and nothing to tell the client: the hint will simply appear once more.
  }
}
