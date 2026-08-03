// The interaction vocabulary for the trainer area (#114), in one place so #51–#53 inherit it
// instead of each re-deriving what a button looks like when you point at it.
//
// ── Why the trainer screens need this and the client screens do not ────────────────────────
// Fingers do not hover. Every client surface is a phone surface, so a control proves itself by
// being 44px and obviously tappable, and there is no pointer to give feedback to. The trainer
// works on a desktop, where the pointer is the whole interaction model and a control with no
// hover response reads as decoration — which is what #50 shipped and the desktop pass caught.
//
// ── What is deliberately absent ────────────────────────────────────────────────────────────
// Transitions. DESIGN.md scopes motion out of v1 entirely, and #114 restates it: state
// changes, not transitions. Hover here is an instant swap of border and background, not a
// 150ms fade. If a future contributor adds `transition-colors` to these strings, that is a
// design decision that belongs in DESIGN.md first.
//
// Focus is also absent, and that is not an oversight: index.css already sets one
// `:focus-visible` outline for the whole app, in --edge-strong, which is the role DESIGN.md
// assigns that token. Restating it per control would be a second source of truth for the
// keyboard affordance, and the trainer screens are not the place to fork it.
//
// ── Why this file is not inside TrainerShell.tsx ───────────────────────────────────────────
// A module that exports both a component and plain values loses fast refresh, which the
// codebase already ran into once (see lib/session.ts). Same reason, same fix.
//
// `enabled:hover:` rather than bare `hover:`: a disabled button must not light up under the
// pointer. It is a promise the control cannot keep.

const BUTTON = 'cursor-pointer rounded-sm px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed'

/** Default action. Bordered, quiet until pointed at. */
export const trainerSecondary =
  `${BUTTON} border border-edge bg-surface text-ink ` +
  'enabled:hover:border-edge-strong enabled:hover:bg-surface-sunk ' +
  'disabled:text-muted'

/** The one amber control per view, per DESIGN.md's "amber means the thing to tap". */
export const trainerPrimary =
  `${BUTTON} bg-accent text-accent-ink ` +
  'enabled:hover:bg-accent-hover ' +
  'disabled:bg-surface-sunk disabled:text-muted'

// Destructive, but bordered rather than a solid --danger surface: it sits inside a table row
// next to ordinary controls, and a filled red block in a roster reads as an alert about the
// row rather than a button in it. The border going red on hover is the confirmation that this
// one is different.
export const trainerDanger =
  `${BUTTON} border border-edge bg-surface text-danger ` +
  'enabled:hover:border-danger enabled:hover:bg-surface-sunk ' +
  'disabled:text-muted'

/** Text-only action, for recovery affordances that should not compete with the page. */
export const trainerQuiet =
  'cursor-pointer text-base font-semibold text-ink underline underline-offset-4 hover:text-ink-bold'

/** Inputs and selects. Hover included because a desktop user hunts for the edit surface too. */
export const trainerField =
  'rounded-sm border border-edge bg-surface px-3 py-2 text-base text-ink ' +
  'hover:border-edge-strong ' +
  'aria-[invalid=true]:border-danger'

/** Nav and in-page links. */
export const trainerLink = 'cursor-pointer hover:text-ink-bold'
