import { Link, useLocation } from 'react-router-dom'

import { trainerNavLink } from './trainerControls'

// The layout the four trainer screens sit in (#50 lands it; #51–#53 fill it).
//
// ── Mobile-first, and what that actually changes ───────────────────────────────────────────
// This comment used to open "Desktop-first", on ui-ux.md's rule that the trainer "views on
// desktop occasionally" and their screens get "responsive-but-unpolished" treatment. #135
// revised the rule: the trainer is on the gym floor with a phone, so these four are designed at
// 390px and widened from there. What that leaves:
//   * max-w-5xl stays, but as the ceiling the layout grows into rather than the width it is
//     designed at. The roster's columns are what the extra width buys; they are a wide-case
//     layout that stacks below sm:, not the shape the screen is built around.
//   * DESIGN.md's --tap-min: 44px is binding here, with no carve-out. It is consumed by
//     trainerControls.ts, so no screen sizes a control itself.
//   * Padding is px-6 at every width, which is the app's single gutter and not a trainer
//     decision at all (#138). #135 had this at px-4/sm:px-8: px-8 spent 64px of a 390px
//     viewport on margins, and px-4 fixed that by inventing a second gutter. The number that
//     survived is the client screens', because their sticky footers are built on -mx-6/px-6.
// Everything else in DESIGN.md still applies. The tokens, the single accent, the border-first
// treatment, the ban on decorative cards: those are the visual system, not a client-screen
// concession, and a trainer area with its own look would be a second design to maintain.
//
// ── Navigation ─────────────────────────────────────────────────────────────────────────────
// ui-ux.md names four trainer screens, but only two of them are ever top-level destinations:
// Clients and Exercise library. Client detail hangs off a client, and the program builder off
// that — both are reached by going through something, not by picking from a bar.
//
// So the nav is a two-item list. It renders only when there is somewhere else to go — a nav bar
// whose single link is the page you are already on is furniture — which is why it was invisible
// while Clients was the only screen that existed. #55 built the Exercise library, so the second
// line is here and the bar appeared on its own, with no change to this component beyond the
// entry below.
//
// Rejected: a sidebar. Two destinations do not need a persistent column, and the trainer is on
// this app occasionally rather than living in it.
// Rejected: building the bar early with links to unbuilt screens. A nav that 404s is worse than
// a nav that is not there yet.
const NAV: { to: string; label: string }[] = [
  { to: '/clients', label: 'Clients' },
  { to: '/exercises', label: 'Exercise library' },
]

export function TrainerShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()

  return (
    <div className="min-h-dvh">
      {/* px-6, the app's one gutter (#138, DESIGN.md §Container discipline). #135 set this to
          px-4/sm:px-8 to claw back content width at 390px, which left a trainer on a 16px
          margin and a client on 24px — the same hand, the same phone, two different pages. The
          client screens were already the reference: their sticky footers and the day picker are
          built on -mx-6/px-6 and would have had to move with any other number. */}
      <header className="border-b border-edge px-6 py-2">
        {/* flex-wrap, because the product name and a two-item nav are one line at 390px only
            while both stay short. items-center rather than items-baseline: the nav links are
            44px boxes now, and baseline-aligning a text run against a box that is mostly
            padding puts the two on visibly different lines. */}
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-1">
          <p className="text-sm font-semibold tracking-wide text-muted">TrainerOS</p>

          {/* The trainer's own name is not shown, because the SPA does not have it: GET /api/me
              is a client-only route (it 404s for a trainer, which is how the session gate
              identifies one at all), and no endpoint returns trainer identity. Rather than
              invent one for a header line, the header says the product name. Worth revisiting
              only if a second trainer account ever exists, which v1 does not have. */}
          {NAV.length > 1 && (
            <nav aria-label="Trainer">
              <ul className="flex gap-6">
                {NAV.map((item) => (
                  <li key={item.to}>
                    <Link
                      aria-current={pathname === item.to ? 'page' : undefined}
                      className={`${trainerNavLink} ${
                        pathname === item.to
                          ? 'text-sm font-semibold text-ink-bold'
                          : 'text-sm text-muted'
                      }`}
                      to={item.to}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </header>

      <main className="px-6 py-8 sm:py-10">
        <div className="mx-auto w-full max-w-5xl">{children}</div>
      </main>
    </div>
  )
}
