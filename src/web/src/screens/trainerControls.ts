// The interaction vocabulary for the trainer area (#114 built it, #132 gave it semantics), in
// one place so the four screens inherit it instead of each re-deriving what a button looks like.
//
// ── Why the trainer screens need this and the client screens do not ────────────────────────
// Not because the trainer is on a desktop. #135 established they are on the gym floor with a
// phone, the same as their clients, and revoked the `--tap-min` carve-out that premise had been
// holding open — which is why every string below now sizes to var(--tap-min).
//
// What survives that correction is the reason this file exists. The client screens are five
// single-purpose surfaces where the one control is obvious from the fact that it is the only
// one; these four stack a roster, a library, a schedule form and a program builder, so a
// trainer needs to tell a destructive control from a navigational one from a commit *within* a
// screen, which is what the vocabulary encodes. Hover is a real part of that on the wide case
// and dead weight on the narrow one — Tailwind gates `hover:` behind `@media (hover: hover)`,
// so a touch device simply never sees it, and none of these controls rely on it to be legible
// at rest. That was #114's actual finding, and it holds under mobile-first unchanged.
//
// ── The rule #132 applies, in one line ─────────────────────────────────────────────────────
// Colour states intent, not importance. --danger means "this takes something away", --accent
// means "this is the action that advances this screen", and everything else is bordered and
// quiet. #114 gave every control the same bordered treatment and left intent entirely to the
// label, which is how "Deactivate" and "Reactivate" ended up as the same object with two words.
//
// The accent half of that sentence was first written as "this commits the form you are filling
// in", which is right inside a form and silent outside one: the two list screens keep their only
// form behind a disclosure, so they rendered no accent at all until you opened it, and a screen
// with nothing amber on it cannot teach "amber means the thing to tap". The browser pass caught
// it and DESIGN.md §Controls now scopes the accent to the *view state* instead. See
// trainerPrimary for what that buys and what it deliberately still excludes.
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
// A third hue. DESIGN.md's palette is one warm accent plus one red and §Messages records why
// there is no success-green: fewer colours, clearer meaning. So a restore, a reactivate and a
// cancel are all bordered neutrals, and the fact that they are *good* is carried by the verb.
//
// ── Why this file is not inside TrainerShell.tsx ───────────────────────────────────────────
// A module that exports both a component and plain values loses fast refresh, which the
// codebase already ran into once (see lib/session.ts). Same reason, same fix.
//
// `enabled:hover:` rather than bare `hover:`: a disabled button must not light up under the
// pointer. It is a promise the control cannot keep.

// `min-h-[var(--tap-min)]` and its `min-w` twin are where #135 lands, and they land here rather
// than on any screen because one string sizes every control in the trainer area. The width is
// not belt-and-braces: the program builder's reorder arrows are a single glyph behind `px-3`,
// which is a 30px-wide target that clears the height rule and misses the point of it. A control
// is 44px on the axis a thumb actually has to hit, which for an icon button is both of them.
//
// `inline-flex` and the two centring utilities come with them. `py-2` alone stopped setting the
// height the moment a min-height above it did, so without a flex box the label sits at the top
// of a 44px button. Call sites that laid these controls out with `inline-block` were updated
// rather than left to fight it (ClientDetailScreen's "Build a program" is the one).
const BUTTON =
  'inline-flex min-h-[var(--tap-min)] min-w-[var(--tap-min)] cursor-pointer items-center ' +
  'justify-center rounded-sm px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed'

/**
 * Default action. Bordered, quiet until pointed at.
 *
 * Deliberately the treatment for a long list of controls that could argue for more, because
 * DESIGN.md's accent budget is spent on commits and its red on removals, and everything else
 * is navigation or a disclosure. Enumerated here so a quiet control is legibly a decision:
 *
 *   * Row-level disclosure toggles ("Edit {name}"). A library of forty rows carries forty of
 *     them, and per-row accent is exactly how §Color's ≤10% budget gets spent. The screen-level
 *     add toggles are the ones that *do* take the accent while closed (see trainerPrimary);
 *     the difference is that there is one of those per screen and forty of these.
 *   * An open disclosure, which by then reads "Close". It gave the accent to the form's submit
 *     when it opened, because two ambers in one gesture make the toggle compete with the thing
 *     it revealed.
 *   * Reorder arrows (Move up / Move down). They rearrange rather than write anything new, and
 *     a day of five rows carries ten of them.
 *   * Link-shaped navigation rendered as a button ("Edit program", "Build a program"). Going
 *     somewhere is not committing anything.
 *   * Restore and Reactivate. These *undo* a destructive act, so they are the one pair that
 *     must not wear --danger, and they are not the surface's primary either. The verb carries
 *     it. Giving them their own colour is exactly the success-green DESIGN.md refuses.
 *   * "Keep it" / "Cancel" inside a confirmation. Dismissal is not a commit, and #132 took the
 *     accent off these: solid amber on the button that does nothing taught "amber means the
 *     thing to tap" against the one surface where the thing to tap is the other one.
 */
export const trainerSecondary =
  `${BUTTON} border border-edge bg-surface text-ink ` +
  'enabled:hover:border-edge-strong enabled:hover:bg-surface-sunk ' +
  'disabled:text-muted'

/**
 * The amber control, per DESIGN.md's "amber means the thing to tap".
 *
 * Scoped per DESIGN.md §Controls: **one per view state, on the action that advances the
 * screen.** Not "one per screen" — the program builder holds a form per prescription and one
 * per day, and a screen-wide singular leaves most of them with no commit signal. Not "one per
 * form" either, which was the previous reading and is what left the roster and the library with
 * zero amber pixels at rest, their only form being behind a disclosure.
 *
 * A disclosure that opens the screen's only creating form is that screen's action while it is
 * closed, so it takes the accent there and gives it up when it relabels to "Close". The two are
 * never simultaneously primary, because the toggle is not itself while the form is open.
 *
 * Still excluded, and the exclusions are the load-bearing part:
 *
 *   * Navigation. Moving to another screen commits nothing.
 *   * Row-level controls. Forty rows times one accent each is how the ≤10% budget dies.
 *   * Dismissals. Amber on the button that does nothing teaches the rule backwards.
 */
export const trainerPrimary =
  `${BUTTON} bg-accent text-accent-ink ` +
  'enabled:hover:bg-accent-hover ' +
  'disabled:bg-surface-sunk disabled:text-muted'

/**
 * Destructive: deactivate, retire, delete a day, delete a prescription.
 *
 * Quiet at rest, committed under the pointer. Red border and red label on paper, inverting to
 * the solid --danger surface with --danger-ink on hover — which is the exact pairing DESIGN.md
 * defines those two tokens for, and which nothing in the app was using.
 *
 * The inversion is what settles #114's objection to a filled red button, and the objection was
 * right: a solid red block sitting in every row of a roster reads as an alert *about* the row
 * rather than a control *in* it. It is not right about the resting state, though. #114 left the
 * border grey and put the whole signal on the label colour, and red-vs-grey text is one axis —
 * the same colour-only failure §Messages spends a paragraph refusing, for the same reason
 * (amber and red at hue 65 and 25 are the textbook deuteranopia pair, and neither survives a
 * greyscale screenshot). The border is the second axis, and it is legible down a column of
 * buttons in a way a word's colour is not.
 *
 * Contrast, measured rather than assumed: --danger on --surface is 4.58:1 and --danger-ink on
 * --danger is 4.53:1, so both states clear AA for normal text. #114's hover filled with
 * --surface-sunk, which put red on a tint at 4.32:1 and failed it, which is the other reason
 * the hover moved.
 *
 * Disabled drops back to --edge: a red border on a control that cannot be pressed promises a
 * hover it will not honour.
 */
export const trainerDanger =
  `${BUTTON} border border-danger bg-surface text-danger ` +
  'enabled:hover:bg-danger enabled:hover:text-danger-ink ' +
  'disabled:border-edge disabled:text-muted'

/**
 * The chosen option in a group of them. Today that is the program's status.
 *
 * Inverted to neutral, per DESIGN.md §Controls: --ink-bold ground, --surface figure. Selection
 * is a strong signal, and this is the only strong one left once amber is spoken for.
 *
 * Two wrong answers preceded it, and the second is the instructive one. First the group painted
 * the *current* status in solid amber, which aimed the palette's one chromatic promise at the
 * single button in the row that does nothing when pressed. Taking the amber off was right;
 * replacing it with --surface-sunk was not. That token is 97% against --surface at 99%, about
 * 1.03:1, so "which status is this program in" was being carried by a difference at the edge of
 * a good monitor's ability to show it and past the edge of a trainer's ability to glance at it.
 * Recessed is the correct *idea* for a pressed control and --surface-sunk is genuinely DESIGN.md's
 * recessed role; the palette simply has no mid-tone between 99% and 78%, so the idea has nothing
 * to render with. Inversion is the signal this scale can actually produce.
 *
 * Not a new colour and not a new token: §Color already inverts locally for primary CTAs, and
 * this is the same move for the other thing that must read as filled. Neutral, so it takes
 * nothing away from amber. Darker than the ~12:1 §Color records for --ink on --surface, and
 * unlike a 1.03:1 tint it survives a greyscale screenshot.
 *
 * Still hovers, because clicking the current status is how a trainer dismisses a rejected
 * transition (see ProgramStatus) and a dead-looking control would hide that. Hover goes to
 * --ink, the one neutral step available in a scale whose only other stop is 22% away.
 */
export const trainerSelected =
  `${BUTTON} border border-ink-bold bg-ink-bold text-surface ` +
  'enabled:hover:border-ink enabled:hover:bg-ink'

/**
 * In-content links: back links, and a link inside a sentence.
 *
 * Carries weight and an underline and sets **no size and no colour**, so a call site's
 * `text-sm text-muted` lands cleanly. Its predecessor (`trainerQuiet`) baked in
 * `text-base font-semibold text-ink` and every back link in the app then fought it with
 * `text-sm text-muted` in the same class string — two Tailwind utilities for one property,
 * where the winner is decided by emission order in the stylesheet rather than by anything at
 * the call site. Both sizes were plausible on screen and neither was chosen.
 *
 * Weight 600 is the strengthening #132 asked for. It is also the only one available: DESIGN.md
 * allows two weights and no third neutral, so an underline plus 600 is the whole vocabulary a
 * link has before it starts borrowing the accent, which belongs to commits.
 */
export const trainerLink = 'cursor-pointer font-semibold underline underline-offset-4 hover:text-ink-bold'

/**
 * The way into a record: the client's name in the roster, the program's title on a client.
 * Assembled by RecordLink, which is the only thing that should consume these three.
 *
 * Not `trainerLink`. An in-prose link underlines at rest because the text around it is also
 * text and nothing else tells them apart. The identifying field of a table row has the opposite
 * problem: it is already the darkest and heaviest thing in its row, sitting in a uniform column
 * above --muted metadata, and it is the exact string the trainer was scanning for. Underlining
 * it adds a rule under all forty of them, which is decoration applied evenly and therefore no
 * signal, and it makes the primary way into a record look like the back link in the header.
 *
 * Dropping the underline was right and dropping it *alone* was the next mistake, caught by the
 * same browser pass. Weight and ink are hierarchy: they say "this is the row's identity", which
 * is precisely what a heading says. They cannot also be the affordance, and a record link with
 * nothing else at rest is a bold heading that turns out to be clickable. The chevron is the
 * affordance; the weight and the ink went back to meaning what they meant before.
 *
 * Shape is the axis this palette has left. Colour is unavailable twice over (DESIGN.md §Color:
 * amber as text is ~3:1 and "would fail as a text color", and it already means "commit this"),
 * a hover target is by definition not an at-rest cue, and the row cannot become one click
 * target because it already contains buttons. §Controls has the full argument.
 */
export const trainerRecordLink =
  'group inline-flex cursor-pointer items-center gap-1 text-base font-semibold text-ink-bold'

/**
 * The label half. Carries the hover underline, because a descendant cannot switch off an
 * ancestor's text-decoration and underlining the anchor would rule through the chevron too.
 * The external-link treatment in ExercisesScreen splits for the same reason.
 */
export const trainerRecordLabel = 'group-hover:underline group-hover:underline-offset-4'

/**
 * The chevron. --muted so it marks the row without competing with the name it follows: the
 * affordance needs to be *present*, not loud, and at forty rows a chevron in --ink would be a
 * second column of dark marks arguing with the names.
 */
export const trainerRecordChevron = 'text-muted'

/**
 * The shell's nav, which is the one link context that stays un-underlined.
 *
 * A nav bar is a fixed set of destinations in a known place, and `aria-current` plus the weight
 * and colour swap in TrainerShell already say which one you are on. Underlining both entries
 * would decorate a landmark rather than mark a control inside prose.
 *
 * Sized like everything else (#135). Two 20px-tall text links 24px apart is a fine pointer
 * target and a coin toss for a thumb, and this is the control a trainer hits most often.
 */
export const trainerNavLink =
  'inline-flex min-h-[var(--tap-min)] cursor-pointer items-center hover:text-ink-bold'

/**
 * Inputs, selects and textareas. Hover included because a pointer hunts for the edit surface too.
 *
 * `max-w-full` is the second of #135's two overflow fixes, and it exists for `<select>`. A select
 * with no width sizes itself to its widest *option*, so the exercise picker is as wide as the
 * longest name in the library and the add-client picker is as wide as the longest IANA timezone
 * string — both comfortably past 390px, and neither visible to anyone testing with short seed
 * data. It is inert on the inputs that carry an explicit `w-20`/`w-32`, which is why it can sit
 * on the shared string instead of being remembered at two call sites.
 *
 * The height matches BUTTON's for the same reason BUTTON has one: a form is a column of
 * alternating labels and controls, and a 40px input beside a 44px button is both under the
 * minimum and visibly ragged.
 */
export const trainerField =
  'min-h-[var(--tap-min)] max-w-full rounded-sm border border-edge bg-surface px-3 py-2 ' +
  'text-base text-ink ' +
  'hover:border-edge-strong ' +
  'aria-[invalid=true]:border-danger'
