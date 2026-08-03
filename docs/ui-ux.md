# TrainerOS — ui-ux.md (v1)

Status: Draft for review
This is deliberately the thinnest spec. The resume value of this project is backend architecture; UI gets exactly the design effort required for real clients to use it, and no more.

---

## Governing rules

1. **Personalization is data, not UI.** One dashboard component, one logging screen, one history view — rendered per-client from their rows. No per-client layouts, themes, or config. (Rejected: "unique dashboard per client" — unmaintainable at 3 clients, impossible at 10.)
2. **Design for the gym floor, not the couch.** The client is between sets: elevated heart rate, phone in one hand, 60–90 seconds of attention. Every logging interaction must survive that context.
3. **Mobile-first web, desktop-tolerant.** Clients are phone-only. The trainer views on desktop occasionally; trainer screens get responsive-but-unpolished treatment.

## Gym-floor constraints (binding on the logging screen)

- Tap targets ≥ 44px; primary actions thumb-reachable (bottom half of screen)
- `inputmode="decimal"` / `"numeric"` on weight/reps — never a full keyboard for numbers
- **Last-time numbers visible while logging** — "what did I do last week" (GET /api/me/last) is displayed inline next to each exercise, not behind a tap. This is the feature that beats the paper notebook; if it's hidden, the notebook wins.
- "Add set" pre-fills from the previous set (most sets repeat weight); editing is the exception path
(Implemented in #45 as an always-present pending row rather than an explicit "Add set" control: saving a set turns it into a static row and the next pre-filled row appears in its place. Same pre-fill behaviour, one tap per set instead of two — which is the intent the original wording was serving. An unused pending row doesn't block Finish; the guard fires on typed values, not suggested ones.)
- Submit buttons disable-on-tap (the api.md non-idempotent POST mitigation lives here)
- Works on a 3-year-old Android over gym wifi: no heavy bundles, no blocking spinners on cached views

## Screen inventory

### Client (5 screens)
| Screen | Content | Notes |
|---|---|---|
| Login | email field → "check your email" state; /verify continue button page | magic-link flow per api.md |
| Today (dashboard) | active program's current day: exercise list with targets, video links, cues; "Start workout" | bootstraps from GET /api/me + /api/me/program |
| Log workout | per-exercise: target (sets × reps @ load), last-time inline, set rows (weight/reps), add-set, session comment field, finish | THE screen. Everything above binds here |
| History | reverse-chron sessions; tap → session detail; per-exercise filter | cursor pagination per api.md |
| Pause reminders | confirmation page + button | token flow per notifications.md |

(Resolved in #43: "current day" was stale wording — nothing in the data model records which day is current, and #38 settled the same question for reminder emails by naming the program rather than a day. Today shows a day picker (rendered only when the program has more than one day), defaulting to the first by position, with Start workout carrying the chosen program_day_id. The client picks; the app doesn't guess. The sticky CTA is hidden when the selected day has no prescriptions.)
(Also #48: a "History" link sits on the Today screen's header line. ui-ux.md specifies no navigation chrome, which was about not building a tab bar for five screens rather than leaving screens unreachable — one link is the minimum honest entry point. Its visual treatment is deliberately quiet; revisit if it needs to stand out more.)

### Trainer (4 screens)
| Screen | Content |
|---|---|
| Clients | list + add/deactivate; per-client: last session date (the "who's slacking" signal — the v1 stand-in for the deferred digest) |
| Client detail | their program (edit entry point), their history, reminder schedule (time, days, enabled) |
| Program builder | days → prescriptions; add exercise from library; drag-or-buttons reorder (buttons acceptable in v1; drag is polish) |
| Exercise library | list/add/edit: name, video URL, cues; soft-delete |

Nine screens total. If a tenth appears during build, it goes through PRODUCT.md scope review, not straight into the sprint.

## Stack & visual decisions

- Tailwind CSS, no component library in v1. (Rejected: shadcn/MUI — 9 screens don't amortize a design system; adding one later is trivial, removing one isn't.)
- Video links open YouTube in a new tab/native app. No embedded player (embed = layout shift + bundle weight for zero logging value).
- Loading states: skeletons on Today/History; none elsewhere.
- No dark mode, no animations, no branding pass in v1. A logo is not on the critical path to the Definition of Shipped.

## Non-goals (v1)

- Progress charts (v1.1 — data model already supports; see database.md)
- PWA install banner / service worker (revisit only if clients ask for "an app icon"; the share-sheet "Add to Home Screen" works today)
- Offline anything
- Trainer mobile optimization beyond "usable"
- Accessibility audit beyond semantic HTML + label/contrast basics (do the basics; skip the formal pass)
