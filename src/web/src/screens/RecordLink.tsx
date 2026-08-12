import { Link } from 'react-router-dom'

import { trainerRecordChevron, trainerRecordLabel, trainerRecordLink } from './trainerControls'

// The way into a record, as one object rather than a shape each screen re-derives.
//
// The rest of the trainer vocabulary is class strings (see trainerControls.ts) because a class
// string is all a button needs. This one is not: a record link is three elements in a fixed
// arrangement, and the arrangement is load-bearing in two ways that a call site copying markup
// gets wrong sooner or later.
//
//   * The chevron must be aria-hidden. Leave it exposed and every accessible name in the roster
//     becomes "Ada Lovelace ›", which is what a screen reader reads out and what the tests
//     match on. The glyph is a visual affordance for sighted users; a screen reader has already
//     been told this is a link.
//   * The underline must sit on the label, not the anchor. A descendant cannot switch off an
//     ancestor's text-decoration, so a hover underline on the anchor rules through the chevron.
//
// DESIGN.md §Controls carries the argument for the chevron itself, including why colour and a
// row-level hover target were not available.
//
// This is not the start of the component library DESIGN.md defers to v1.1+. That deferral is
// about button/input/card/modal primitives; this is one component for one pattern with two call
// sites, which is the "ad-hoc under the tokens" the same line permits.
export function RecordLink({ children, to }: { children: React.ReactNode; to: string }) {
  return (
    <Link className={trainerRecordLink} to={to}>
      <span className={trainerRecordLabel}>{children}</span>
      <span aria-hidden="true" className={trainerRecordChevron}>
        &#8250;
      </span>
    </Link>
  )
}
