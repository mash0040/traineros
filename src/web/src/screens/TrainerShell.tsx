import { Link, useLocation } from 'react-router-dom'

// The layout the four trainer screens sit in (#50 lands it; #51–#53 fill it).
//
// ── Desktop-first, and what that actually changes ──────────────────────────────────────────
// ui-ux.md: clients are phone-only, the trainer "views on desktop occasionally", and trainer
// screens get "responsive-but-unpolished" treatment. Two concrete consequences, so nobody has
// to re-derive them per screen:
//   * The container is wide (max-w-5xl) rather than the client screens' max-w-lg. A roster with
//     five columns on a 26rem column is a phone layout nobody asked for.
//   * DESIGN.md's --tap-min: 44px is binding on client surfaces and explicitly relaxed here.
//     Trainer controls are sized for a pointer. They are still not tiny — "unpolished" is a
//     licence to skip the layout pass, not to build something unusable on a laptop trackpad.
// Everything else in DESIGN.md still applies. The tokens, the single accent, the border-first
// treatment, the ban on decorative cards: those are the visual system, not a client-screen
// concession, and a trainer area with its own look would be a second design to maintain.
//
// ── Navigation ─────────────────────────────────────────────────────────────────────────────
// ui-ux.md names four trainer screens, but only two of them are ever top-level destinations:
// Clients and Exercise library. Client detail hangs off a client, and the program builder off
// that — both are reached by going through something, not by picking from a bar.
//
// So the nav is a two-item list, and today it holds one item because one screen exists. It
// renders only when there is somewhere else to go: a nav bar whose single link is the page you
// are already on is furniture. #53 adds the Exercise library line to NAV and the bar appears
// on its own.
//
// Rejected: a sidebar. Two destinations do not need a persistent column, and the trainer is on
// this app occasionally rather than living in it.
// Rejected: building the bar now with links to unbuilt screens. A nav that 404s is worse than
// a nav that is not there yet.
const NAV: { to: string; label: string }[] = [{ to: '/clients', label: 'Clients' }]

export function TrainerShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()

  return (
    <div className="min-h-dvh">
      <header className="border-b border-edge px-8 py-4">
        <div className="mx-auto flex w-full max-w-5xl items-baseline justify-between gap-6">
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
                      className={
                        pathname === item.to
                          ? 'text-sm font-semibold text-ink-bold'
                          : 'text-sm text-muted'
                      }
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

      <main className="px-8 py-10">
        <div className="mx-auto w-full max-w-5xl">{children}</div>
      </main>
    </div>
  )
}
