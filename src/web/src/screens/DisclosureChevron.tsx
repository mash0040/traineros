// The affordance on a control that opens something in place, shared by the two history surfaces
// that have one (#142).
//
// ── Why this exists at all ─────────────────────────────────────────────────────────────────
// #132's finding, in DESIGN.md §Controls: weight and ink are *hierarchy* — they say "this is
// the row's identity", which is what a heading says — and they cannot also be the affordance.
// "A record link with nothing but weight and ink at rest reads as a bold heading that happens
// to respond to a click." The history session rows had exactly that shape: a bold date, a muted
// summary, and nothing at rest saying they open.
//
// ── Why not the record link's `›` ──────────────────────────────────────────────────────────
// Because that glyph is spoken for, and the vocabulary only works while each mark means one
// thing. DESIGN.md assigns `↗` to "this link leaves the app" and `›` to "this opens a record
// inside it". A disclosure goes nowhere — it reveals what is already on the page — so reusing
// `›` would give it a third meaning and cost the other two their precision.
//
// `▾` / `▴` is a fourth mark on the axis §Messages already argues is the durable one: shape.
// Independent of colour, weight and decoration, so it survives greyscale and deuteranopia, and
// unlike a static chevron it carries *state* — which is the thing a disclosure has and a record
// link does not. `aria-expanded` on the button is the same fact in the channel that cannot see
// it, which is why this glyph is aria-hidden rather than labelled.
//
// --muted, for the reason the record chevron is: the affordance needs to be present, not loud.
// Down a column of forty sessions, a chevron in --ink would be a second column of dark marks
// arguing with the dates.
export function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <span aria-hidden="true" className="shrink-0 text-sm text-muted">
      {open ? '▴' : '▾'}
    </span>
  )
}
