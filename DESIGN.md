# TrainerOS — DESIGN.md (v1)

Status: v1 seed. Regenerate once real screens exist and CSS tokens have been exercised in components.

Register: **product** (inferred from PRODUCT.md scope; not written back to PRODUCT.md per the v1 scope freeze). Design serves the workflow — it is not the product.

Companion to `docs/ui-ux.md`. That doc owns *what screens exist and how they behave*. This doc owns *what those screens look like*. Where they overlap, ui-ux.md wins on behavior, DESIGN.md wins on visual system.

---

## Overall vibe

A workshop tool, not a lifestyle brand. Legible under gym lighting, honest under close inspection, uncluttered by decoration. The mental model is a well-made notebook page: paper, ink, and one strip of highlighter tape that says "tap here."

Deliberately rejected:

- The fitness-app category reflex: dark UI, neon green, hero metric tiles, gradient stroke charts. That aesthetic sells subscriptions to lifestyle apps; it does not help someone log a set between bench presses.
- The wellness-editorial second-order reflex: cream backgrounds, apricot accents, serif display type, generous white space as a stand-in for "calm." Also not our register.
- Any decorative treatment (glass, gradients as text fill, side-stripe borders on cards) — see "Absolute bans" below.

## Color

**Strategy: Restrained.** Cool-tinted neutral scale + a single warm accent used sparingly for primary actions. Accent occupies ≤10% of any surface's pixels.

**Contrast direction:** dark ink on light surface throughout. No dark mode in v1 (per ui-ux.md). Primary CTAs invert locally — near-paper text on amber surface — because amber's job is to be the *ground*, not the *figure*. Amber-on-paper is only ~3:1 and would fail as a text color; paper-on-amber clears AA and is unmistakable at gym-arm distance.

**Palette (OKLCH):**

| Token | Value | Role |
|---|---|---|
| `--surface` | `oklch(99% 0.006 250)` | Primary background (near-paper, cool-tinted) |
| `--surface-sunk` | `oklch(97% 0.006 250)` | Recessed backgrounds (muted rows, disabled inputs) |
| `--edge` | `oklch(90% 0.007 250)` | Hairline borders (1px), input outlines |
| `--edge-strong` | `oklch(78% 0.008 250)` | Section dividers, focus rings |
| `--muted` | `oklch(52% 0.010 250)` | Secondary text (labels, "last time" values, timestamps) |
| `--ink` | `oklch(22% 0.012 250)` | Primary text |
| `--ink-bold` | `oklch(14% 0.014 250)` | Headings, emphasized numbers |
| `--accent` | `oklch(64% 0.17 65)` | Primary CTA surface (amber) |
| `--accent-hover` | `oklch(56% 0.18 65)` | Pressed / hover state |
| `--accent-ink` | `oklch(99% 0.010 80)` | Text on `--accent` |
| `--danger` | `oklch(58% 0.19 25)` | Destructive action surface (deactivate, cancel unsaved) |
| `--danger-ink` | `oklch(99% 0.010 25)` | Text on `--danger` |
| `--accent-surface` | `oklch(64% 0.17 65 / 0.10)` | Tinted panel behind a confirmation message |
| `--accent-edge` | `oklch(64% 0.17 65 / 0.32)` | 1px border on a confirmation message |
| `--danger-surface` | `oklch(58% 0.19 25 / 0.07)` | Tinted panel behind a failure message |
| `--danger-edge` | `oklch(58% 0.19 25 / 0.28)` | 1px border on a failure message |

**Why these choices, in one line each:**

- Neutrals tint at hue 250 (cool blue), chroma 0.006–0.014. Enough to lift them off `#fff/#000` without reading as "blue," honest under white LED gym lighting, consistent with the "never `#000/#fff`" shared law.
- Amber (hue 65) is the only chromatic color in the palette; it *is* the primary-action signal. Users learn "amber means the thing to tap" within one session.
- Amber deliberately dodges category reflexes: not fitness-green, not neon-yellow, not wellness-apricot. Its warmth against cool neutrals gives chromatic uniqueness, not raw luminance contrast — hence the paper-on-amber contrast direction called out above.
- No success-green. Confirmations are amber (the "committed" color) or a check mark in `--ink`. Fewer colors, clearer meaning. See §Messages for how that is actually rendered — the four `-surface`/`-edge` tokens are alpha over `--accent`/`--danger`, not new hues, so the palette is still one warm accent plus one red.

**Semantic naming is deliberate. Do not rename to literal color names (`--white`, `--black`, `--amber-500`).** The point of `--surface` / `--ink` / `--edge` / `--accent` is that adding a dark mode post-v1 becomes a values change under the same names, not a codebase-wide refactor. If a future contributor "simplifies" `--ink` to `--gray-900`, they have destroyed the token's purpose. Reject the PR.

## Typography

**Font stack:** system UI only. `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`. No web font in v1 — bundle weight for zero logging value, and native SF/Segoe/Roboto renders correctly on the target devices (see ui-ux.md gym-wifi constraint).

**Numerics:** `font-variant-numeric: tabular-nums` on the logging table (weight, reps, last-time columns). Numbers must align vertically for scanning.

**Scale (ratio 1.25, six steps):**

| Token | Size | Line-height | Role |
|---|---|---|---|
| `--text-xs` | 12px | 16px | Meta text, timestamps |
| `--text-sm` | 14px | 20px | Labels, secondary UI |
| `--text-base` | 16px | 24px | Body |
| `--text-lg` | 20px | 28px | Section headings, prominent numbers |
| `--text-xl` | 25px | 32px | Screen headings |
| `--text-2xl` | 31px | 40px | Oversized numbers (rare in v1) |

**Weight:** 400 body, 600 for headings and value-emphasis (e.g. the weight/reps number in a completed set row). Two weights only.

## Spacing & layout

**Base unit:** 4px (Tailwind default). Scale: 4, 8, 12, 16, 24, 32, 48, 64.

**Rhythm rule:** vary spacing deliberately. Inside a set row: tight (4–8px vertical). Between exercises: generous (24–32px). Between a screen's major sections: 48px. Same padding everywhere is monotony (per shared law).

**Container discipline:** no reflexive `max-w-*` wrapper on the root of a page. Containers appear where the *content* is genuinely bounded (a form, a session card). The page shell is the viewport minus safe-area padding, nothing more.

**Thumb-reach zone (client screens, binding).** Primary CTAs live in the bottom half of the mobile viewport, ideally the bottom third. Sticky footer CTA is the pattern for logging. `--tap-min: 44px` is consumed by button/input `min-height` — never smaller on client-facing surfaces.

**Cards.** Used only where the unit is genuinely bounded and the whole thing is meaningful as one object (a session row in history, an exercise block in the logging screen). Never nested. Never as decoration for a heading + paragraph.

## Log row: three-number hierarchy

An exercise row on the client Log workout screen carries three numeric groups, ranked by role. Committing to a rank and a treatment for each keeps set logging (#45) and inline last-time (#46) producing one coherent row rather than two designs. Any change to a rank's treatment is a design decision, not a component tweak.

**Rank 1: today's inputs.** The editable weight and reps for the current set. Largest, highest-contrast, primary tap target.

- Size `--text-lg` (20px), weight 600, color `--ink-bold`, `tabular-nums`.
- Two inputs side-by-side (weight / reps), each `min-height: var(--tap-min)` (44px), digits right-aligned.
- `inputmode="decimal"` on weight, `inputmode="numeric"` on reps (per ui-ux.md).
- Position: right side of the row, thumb-adjacent.

**Rank 2: last-time performance.** The weight × reps the client hit for this exercise last time. Must be readable at arm's length, mid-set, without tapping. This is the feature that beats the paper notebook; if it recedes into label styling, the notebook wins.

- Size `--text-base` (16px), weight 600, color `--ink`, `tabular-nums`.
- Format `72.5 × 8`. The `×` renders in `--muted` at the same size so the numbers dominate the glyph.
- Column header `Last` in `--text-xs` (12px), weight 400, `--muted`, once above the column — not repeated per row. A column needs naming once; four stacked labels is repetition, and it competes with the values it is supposed to introduce.
- Position: own column, left of the inputs. Successive sets stack into a stable vertical strip of last-time values under the one header.
- Empty state (no prior data, or a set number the client didn't reach last time): a single `–` at `--muted` in the cell. Not "no data yet" copy. Dashes hold the row's place so the strip stays aligned to set number.
- The visible header is decorative to assistive tech: each cell carries its own visually-hidden label, because a column header is not programmatically associated with the cells beneath it and a row-by-row reading would otherwise announce a bare number.

**Rank 3: prescribed target.** The trainer's prescription as free text (`8–10`, `RPE 8`, `3×5 @ 80%`). Read once per exercise, not per set.

- Size `--text-sm` (14px), weight 400, color `--muted`.
- Position: header of the exercise block, above the set rows. Never repeated per row.
- Never bolded, never colored.

**Row order, left-to-right (mobile):** `[set #] [last-time column] [weight input] [reps input]`.

**Column headers.** One header row per exercise block, above the set rows, naming every column once at the same height: `Last`, `kg`, `Reps`, all `--text-xs` / 400 / `--muted`. `kg` and `Reps` are right-aligned over their right-aligned digits; `Last` is not. No labels appear inside the rows themselves. The header row is decorative to assistive tech — it has no programmatic association with the cells below it — so every cell carries its own label: values via visually-hidden text, inputs via `aria-label` naming the unit in full.

Known tradeoff: only the last row holds inputs, so as sets are logged the inputs travel down the block away from their headers. At six sets they are roughly a screen-third apart. What holds the columns legible at that distance is the saved rows between them — same columns, same alignment, same `tabular-nums` — not the header. If that ever stops being true, the answer is a sticky header row inside the block, not labels back in every row.

**Forbidden collapses:**

- Prescribed target promoted next to each set row (Rank 3 → Rank 1 visually).
- Last-time rendered as a subtitle, tooltip, or icon (Rank 2 hidden; notebook wins).
- Last-time's weight and size matched to the input labels (Rank 2 collapsed to labelling).
- Bolding the `×` glyph or the `Last` header to "balance" the row. The numbers balance it.
- Repeating the `Last` label per row. It names a column, and the column is named once.

## Messages: errors, validation failures, confirmations

**Scope: trainer screens.** Surfaced by the #53/#54 desktop passes. Client screens are single-purpose (one form, one outcome, one screen) and their few messages are the whole content of the view they appear in; trainer screens stack six or eight write surfaces on one page, which is where an undifferentiated message stops working.

**The defect.** Every message rendered as `--text-sm` in one of two text colors, at weight 400, in the same slot under the control that produced it. A save confirmation and a rejected write were separable only by *reading* them, which is precisely what someone does not do when they glance back at a form after clicking Save. Colour alone was carrying the entire signal, and it was carrying it at 14px in a paragraph the eye has no reason to stop on.

**Two tones. Failures keep `--danger`; confirmations take the amber accent, which already means "committed" in this palette (see §Color). Separation comes from treatment, not from a third semantic colour** — this system does not get a success-green, a warning-orange, or an info-blue.

| | Failure | Confirmation |
|---|---|---|
| Panel | `--danger-surface` | `--accent-surface` |
| Border | 1px `--danger-edge`, full (never a side stripe) | 1px `--accent-edge`, full |
| Text | `--ink-bold`, weight 600 | `--ink`, weight 400 |
| Leading glyph | `!` in `--danger` | `✓` in `--ink` |
| ARIA role | `alert` | `status` |
| Size | `--text-sm` | `--text-sm` |

**Colour is the axis that carries least, deliberately.** Amber (hue 65) and red (hue 25) are ~40° apart and are the textbook deuteranopia confusion pair; a red-vs-amber tint at 7–10% alpha is close to no signal at all for a red-green colourblind trainer, and none for anyone reading a greyscale screenshot in a bug report. So the tint is the *ambient* cue and the glyph plus the weight are the *actual* one. All three are required. A message that keeps the tint and drops the glyph has quietly reverted to colour-only.

**Why weight, and why it goes on the failure.** Two weights exist in this system (400/600) and 600 is defined as value-emphasis. A failure is the message that must interrupt; a confirmation is the message that must be *available* without interrupting, because the trainer already knows they clicked Save. Bolding both would flatten them again in the opposite direction.

**Size stays at `--text-sm` for both.** The temptation is to enlarge failures. Rejected: these messages sit inside form clusters, and a message that changes size changes the height of the block it appears in, which moves the controls under it at the moment the trainer is reaching for them.

**Loading and progress text is neither tone.** "Loading your clients" is not an outcome; it stays plain `--muted` body text with `role="status"` and gets no panel. Panels mean *something happened*.

### Does the single-accent rule need an explicit carve-out?

**No — and recording one would be wrong.** `--tap-min` needed a carve-out because trainer screens genuinely violate it: 44px controls sized for a thumb are the wrong size for a pointer, so the rule is suspended. Nothing here is suspended. Amber for confirmations is not an exception to §Color, it is §Color: "Confirmations are amber (the 'committed' color)" has been in that section since v1 and the trainer screens simply were not doing it.

**What does need recording is a boundary, and it is this:**

> Solid `--accent` remains reserved for the primary action. A message panel may only ever use `--accent-surface` (≤12% alpha). Amber as a *ground* means "tap this"; amber as a *tint* means "this committed". A confirmation rendered on solid amber would be the first non-clickable thing in the product wearing the CTA's own surface, and one screen after that "amber means the thing to tap" is no longer true.

That boundary also settles the ≤10%-of-pixels budget in §Color: that budget counts saturated accent — solid `--accent` surfaces — and a 10%-alpha tint over near-paper is not that. A confirmation panel does not spend the button's budget.

**Ban restated locally, because message panels are where it always gets broken:** no coloured `border-left` stripe. Full 1px border or nothing (see §Absolute bans).

### Copy is the SPA's, not the API's

A treatment fix does not help if the sentence inside it was written for a developer. Trainer-facing error text was the API's `message` field rendered verbatim, and those strings were written across a dozen endpoint tickets as developer explanations: `Unknown exercise_id.`, `Not Found`, `ordered_ids contains duplicates.` reach the trainer exactly like that.

**Rule: the SPA owns trainer-facing error copy, keyed on the error `code`, falling back to the server's `message` for codes it has not mapped.** The code is the stable contract (api.md); the message is prose that may be reworded by any API ticket without warning.

The fallback is not a concession — it is load-bearing. `bad_request` covers ~27 distinct validation failures under one code, so a single rewrite of it would say *less* than the string it replaced. Those are left to the server, which is the only layer that knows which field it rejected. Splitting `bad_request` into per-field codes is an API change, not a web one.

**The SPA maps a code when it knows something the API cannot.** That is the test for whether an entry belongs in the map. A retired exercise coming back as `unknown_exercise` is the canonical case: the server knows the id is not selectable, but only the SPA knows the trainer is looking at a picker populated before the exercise was retired, so only the SPA can say *reload to see the current library*. Where the SPA knows nothing extra, the server's sentence stands.

Copy in the map obeys §Absolute bans like any other string: **no em dashes**, including in the reload-prompt pattern above.

## Controls: what takes the accent, what "selected" looks like, what a link to a record is

**Scope: trainer screens**, for the same reason §Messages is. A client screen is one purpose and one obvious control; these four stack a roster, a library, a schedule form and a program builder, and every question below is a question about which of eleven controls on one page the eye should land on first.

### The accent is scoped to the view state, not to the form

**The defect.** §Color says amber "*is* the primary-action signal" and budgets it at ≤10% of a surface's pixels, but never says what "primary" is scoped to. The trainer screens were built to a working rule of *one accent per form, on the control that commits it*, which is correct inside a form and says nothing at all outside one. On the two list screens the only creating form sits behind a disclosure toggle, so the rule left them rendering **zero accent pixels at rest**. A budget of ≤10% was being met with 0%, and a screen where nothing is amber is a screen where "amber means the thing to tap" has nothing to teach.

**Rule:**

> Every trainer view has exactly one solid `--accent` control **in each state it can be in**, and it marks the action that advances the screen's purpose. A disclosure that opens the screen's only creating form is that action while it is closed. Once open it relabels ("Close") and drops to bordered, and the form's submit takes the accent.

The relabel is what makes this safe rather than a second amber: the toggle and the submit are never both primary, because the toggle is never *itself* while the form is open. One accent at rest, one while filling.

**What still does not take the accent, and why the rule does not swallow them:**

- **Navigation.** A control that moves you to another screen commits nothing. "Build a program" stays bordered on a client with no program even though it is the most inviting thing in the section; the screen's accent belongs to the schedule form, which is the control on that screen that writes.
- **Row-level controls in a list.** A roster of forty rows has forty edit toggles, and per-row accent is how the ≤10% budget is actually blown. The screen's accent is the screen's, not each row's.
- **Dismissals.** "Cancel", "Keep it", "Close". Solid amber on the button that does nothing teaches the opposite of the rule on the one surface where the thing to tap is the other one.
- **A view with no writes at all.** It gets no accent, and that is the correct outcome, not a violation to be patched. The rule says one per state, not one forced into every state.

### Selected state: neutral inversion, never a tint

**The defect.** A group of mutually exclusive options (the program builder's draft / active / archived) first rendered the *current* option in solid `--accent`, which pointed the palette's one chromatic promise at the single button in the row that does nothing when pressed. Replacing it with `--surface-sunk` fixed the wrong thing and broke a second: `--surface-sunk` is 97% against `--surface` at 99%, roughly 1.03:1, which is a texture rather than a state. Active and archived became indistinguishable at a glance.

**Rule:**

> A selected control inverts to neutral: `--ink-bold` ground, `--surface` figure, hovering to `--ink`. Selection is a *strong* signal carried by a *neutral* one. `--surface-sunk` is a recessed background for rows and disabled inputs and cannot carry state at 2% lightness separation; it is not a selected state and must not be used as one.

This is the same local inversion §Color already blesses for primary CTAs ("Primary CTAs invert locally"), applied to the other thing that needs to read as *filled*. It costs no new token and no new hue, it is darker than the ~12:1 §Color records for `--ink` on `--surface`, and it survives greyscale, which a tint at 1.03:1 does not.

**The selected control keeps its hover.** It is still clickable (in the status group, clicking the status you are already in is how a rejected transition gets dismissed) and a dead-looking control hides that.

### Links to a record are not underlined prose

**The defect.** The way into a client was the client's name, styled as an in-prose link: underline, weight 600, body colour. In a column of forty names that reads as forty underlined phrases, which is decoration applied uniformly and therefore no signal at all, and it makes the primary way into a record look like the back link in the page header.

**Removing the underline is half a decision, and shipping only that half is a second defect.** Weight and ink are *hierarchy*: they say "this is the row's identity", which is what a heading says. They are not an affordance, and a record link with nothing but weight and ink at rest reads as a bold heading that happens to respond to a click. The underline was the wrong affordance; the answer is a different one, not none.

**Rule:**

> A record link carries a trailing `›` in `--muted`, at rest, inside the link. Weight and ink stay, and they carry hierarchy only. The chevron is the affordance.

| | In prose | To a record |
|---|---|---|
| Where | Back links, a link inside a sentence | The identifying field of a row in a list or table |
| At-rest affordance | Underline | Trailing `›` in `--muted` |
| Underline | Always, at rest | On hover, on the label only |
| Weight | 600 | 600 |
| Colour | Inherited from the call site | `--ink-bold` |
| Size | Inherited from the call site | `--text-base` |

**Why a chevron and not the two other candidates:**

- **Not colour.** The palette has one chromatic hue and it is spoken for. §Color rules amber out twice over: as text it is "only ~3:1 and would fail as a text color", and semantically it means "tap this to commit", which a navigation link does not. A dedicated link-blue is a third hue, refused for the same reason there is no success-green.
- **Not a row-level hover target.** A hover affordance is by definition absent at rest, which is the defect, and it is pointer-only. It would also need a row background to hover *to*, and the only candidate is `--surface-sunk` at 1.03:1, ruled out one subsection above. A whole-row click target is separately unavailable: these rows already contain buttons, and interactive elements do not nest.
- **A chevron is a fourth axis: shape.** Independent of colour, weight and decoration, so it survives greyscale and deuteranopia, and it is the axis §Messages already leans on when it makes the glyph the actual signal and the tint merely ambient. It also extends a vocabulary this product already has, rather than inventing one: `↗` already marks a link that leaves the app, so `›` marks one that opens a record inside it.

**Forty chevrons is not the same objection as forty underlines.** An underline alters the text's own rendering, so applying it to every name in a column asserts that those *words* are special, which is not true of any one of them. A chevron is a discrete mark at the link's trailing edge asserting that every row in this column opens something, which is true, and which is structure rather than decoration. Uniformity is the message there, not the failure.

**The chevron is `aria-hidden` and lives inside the link.** Inside, so it is part of the hit area and travels with the label; hidden, so the accessible name stays the record's name. A screen reader is already told this is a link and does not need a glyph to say so, which is exactly why the glyph is free to be purely visual.

**The hover underline goes on the label, never the anchor.** A descendant cannot switch off an ancestor's `text-decoration`, so underlining the anchor draws the rule under the chevron too. Same split the external-link treatment already uses.

**The in-prose treatment sets no colour and no size of its own.** It baked in both once, and every call site then fought it with a second utility for the same property, where the winner was decided by Tailwind's emission order rather than by anything at the call site.

**One way in per row.** If a row's record link goes somewhere, that row does not also carry a button going to the same place. A second control pointing where the first one points is the thing a scannable column is for.

## Elevation & borders

**Border-first.** `1px solid var(--edge)` is the default separator. Cards, inputs, and dividers all use it. Elevation via shadow is reserved for the sticky bottom CTA (implies floating over scroll content) and toast notifications.

**Shadow (single value):** `0 -2px 8px oklch(22% 0.012 250 / 0.08)`. Used on the sticky footer container to lift it visually off scrolled content. No other shadow appears in v1.

**No glass, no blur, no gradient backgrounds anywhere.**

## Radius

- `--radius-sm: 4px` — inputs, small buttons
- `--radius-md: 6px` — cards, larger buttons, sticky footer
- `--radius-pill: 999px` — icon-only round buttons (rare; if a button has a text label it is not a pill)

## Motion

**Scoped absent in v1.** No transitions, no animations, no scroll effects (per ui-ux.md). This is a deliberate deferral, not an oversight — the design system reserves motion for v1.1+.

When motion is added post-v1:

- Ease-out only, exponential curves (ease-out-quart / quint / expo) per shared laws.
- Never bounce, never elastic.
- Never animate CSS layout properties.
- Respect `prefers-reduced-motion` from day one.

## Accessibility

- Every color pairing above meets or exceeds WCAG AA (4.5:1 normal text, 3:1 large text). `--ink` on `--surface` is ~12:1; `--accent-ink` on `--accent` clears 4.5:1; `--muted` on `--surface` clears 4.5:1 at body size.
- `--tap-min: 44px` baked into button/input min-heights for client screens. Trainer screens (desktop) may relax.
- Semantic HTML always. `<button>` never a `<div>`. `<label>` associated with every input.
- No formal audit committed in v1 (per ui-ux.md). Do the basics; skip the theater.

## Absolute bans (restated for local reference)

Inherited from shared design laws — restated here so nobody has to open another doc mid-review:

- **Side-stripe borders.** No colored `border-left`/`border-right` >1px on cards or alerts. Rewrite with full borders, background tints, or leading icons.
- **Gradient text.** No `background-clip: text` on gradients. Solid colors only; emphasize via weight or size.
- **Glassmorphism as default.** No blurred/translucent surfaces.
- **Hero-metric templates.** Big number + label + accent stripe = SaaS cliché. If a big number matters, treat it typographically, not with chrome.
- **Identical card grids.** Same-sized icon + heading + text cards, repeated. Vary or find a different structure.
- **Modal as first thought.** Prefer inline / progressive alternatives.
- **Em dashes.** Commas, colons, semicolons, periods, or parentheses instead. Also not `--`.

## Tailwind v4 integration

Tokens live in `src/web/src/index.css` under `@theme`, so they surface as utility classes automatically:

```css
@import "tailwindcss";

@theme {
  --color-surface:       oklch(99% 0.006 250);
  --color-surface-sunk:  oklch(97% 0.006 250);
  --color-edge:          oklch(90% 0.007 250);
  --color-edge-strong:   oklch(78% 0.008 250);
  --color-muted:         oklch(52% 0.010 250);
  --color-ink:           oklch(22% 0.012 250);
  --color-ink-bold:      oklch(14% 0.014 250);
  --color-accent:        oklch(64% 0.17 65);
  --color-accent-hover:  oklch(56% 0.18 65);
  --color-accent-ink:    oklch(99% 0.010 80);
  --color-danger:        oklch(58% 0.19 25);
  --color-danger-ink:    oklch(99% 0.010 25);

  /* §Messages. Alpha over the two chromatic tokens above, declared as tokens rather than
     written as bg-accent/10 at each call site so dark mode stays a values change. */
  --color-accent-surface: oklch(64% 0.17 65 / 0.10);
  --color-accent-edge:    oklch(64% 0.17 65 / 0.32);
  --color-danger-surface: oklch(58% 0.19 25 / 0.07);
  --color-danger-edge:    oklch(58% 0.19 25 / 0.28);

  --radius-sm: 4px;
  --radius-md: 6px;

  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

:root {
  --tap-min: 44px;
  --shadow-sticky: 0 -2px 8px oklch(22% 0.012 250 / 0.08);
}
```

Utility usage: `bg-surface`, `text-ink`, `border-edge`, `bg-accent text-accent-ink`, etc. Tailwind v4 derives class names from token names automatically.

## Explicit v1.1+ deferrals

Called out so no future contributor mistakes an absence for an omission:

- Dark mode (token override under the same semantic names — not a fork)
- Motion vocabulary (transitions, animations, page transitions)
- Custom typeface / web font
- Logo, brand mark, favicon beyond the Vite default
- Full component library (button, input, card, modal, toast primitives) — v1 builds these ad-hoc under the tokens above
- Progress-chart color scale (see PRODUCT.md non-goals — charts are v1.1)
- Empty-state illustrations / marketing surfaces
