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

**Why these choices, in one line each:**

- Neutrals tint at hue 250 (cool blue), chroma 0.006–0.014. Enough to lift them off `#fff/#000` without reading as "blue," honest under white LED gym lighting, consistent with the "never `#000/#fff`" shared law.
- Amber (hue 65) is the only chromatic color in the palette; it *is* the primary-action signal. Users learn "amber means the thing to tap" within one session.
- Amber deliberately dodges category reflexes: not fitness-green, not neon-yellow, not wellness-apricot. Its warmth against cool neutrals gives chromatic uniqueness, not raw luminance contrast — hence the paper-on-amber contrast direction called out above.
- No success-green. Confirmations are amber (the "committed" color) or a check mark in `--ink`. Fewer colors, clearer meaning.

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
