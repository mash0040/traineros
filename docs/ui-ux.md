# TrainerOS — ui-ux.md (v1)

Status: Draft for review
This is deliberately the thinnest spec. The resume value of this project is backend architecture; UI gets exactly the design effort required for real clients to use it, and no more.

---

## Governing rules

1. **Personalization is data, not UI.** One dashboard component, one logging screen, one history view — rendered per-client from their rows. No per-client layouts, themes, or config. (Rejected: "unique dashboard per client" — unmaintainable at 3 clients, impossible at 10.)
2. **Design for the gym floor, not the couch.** The client is between sets: elevated heart rate, phone in one hand, 60–90 seconds of attention. Every logging interaction must survive that context.
3. **Mobile-first web, desktop-tolerant — for both audiences.** Clients are phone-only. So, in practice, is the trainer: they use these screens on the gym floor between clients, not at a desk. Every screen is designed at 390px first and widened from there; desktop is the wide case, not the primary one.

(Revised in #135. This rule read "the trainer views on desktop occasionally; trainer screens get responsive-but-unpolished treatment", which was wrong about where the trainer stands. Because it was a governing rule, nothing downstream challenged it: it licensed a `--tap-min` carve-out in DESIGN.md, four screens built to it, and every review since #50 asking for a desktop pass. A phone-sized roster was never a missing polish pass — it was this sentence.)

## Gym-floor constraints

Binding on the logging screen in full. The first constraint — **tap targets and thumb reach** — is binding everywhere, trainer screens included: the trainer is holding a phone in the same room, under the same lighting, with a client waiting. The rest of this list is about logging sets and applies where sets are logged.

- Tap targets ≥ 44px; primary actions thumb-reachable (bottom half of screen). On the logging screen thumb reach is the sticky footer CTA; on trainer screens it means the action that commits sits at the end of the flow it belongs to — under the list it adds to, under the form it saves — never pinned above content the trainer has to reach past. Trainer screens do not get sticky CTAs: they are read-and-edit screens with several write surfaces, and a footer pinned over one of them would be claiming to be the action for all of them.
- `inputmode="decimal"` / `"numeric"` on weight/reps — never a full keyboard for numbers. The weight and reps fields are `type="text"` carrying an inputmode, **not** `type="number"`: number inputs change their own value on a stray scroll wheel, reject a locale's decimal comma, and put spinners inside a 44px target.

(**Step increments were tried and removed** — #99 follow-up — so that they do not get reinvented. Stepping weight by a plate increment (2.5 lb / 0.5 kg) sounds like an obvious input aid and cannot be had cheaply here. The web mechanism is the `step` attribute, which only `type="number"` honours, so using it means reversing the decision above; and the device this screen is designed for is a phone, where `step` renders no control at all. It was briefly implemented as an ArrowUp/ArrowDown keydown handler instead, which avoided the reversal but bought an affordance with no visible sign of itself — invisible on the target device and undiscoverable on any other, which is worse than not having it. Removed.

The route that would actually work is explicit +/− buttons, and that is a real design decision rather than an attribute: two more controls per exercise row on the screen DESIGN.md spends its longest section protecting. It belongs in a ticket with a mock, not in a follow-up. Note also that any stepping is an *input* aid only — nothing displayed is ever rounded to a plate grid, because 50 lb is 22.68 kg and showing 22.5 would be a weight she did not lift, which is the same rule that governs display rounding in database.md §users.)
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
(Amended by #107: a saved set row can be **edited**, not only removed. `PATCH /api/me/sets/:id` had existed since #32 and nothing called it, so correcting a 100 typed for 10 meant deleting the set and logging it again — and mistyping is commoner than mis-logging. Three decisions in it.

**Editing happens in the row, not in the strip.** The strip carries `[Edit set N] [Remove set N]`, and Edit swaps that row's two value cells for fields. The row is a subgrid of the block's four tracks and the pending row directly below uses the same two tracks for its own fields, so the field you type into is the same width, in the same column, as both the number it replaces and the row beneath. Fields in the strip would have put a second pair of weight/reps inputs on screen in a different position from the pending row's, which is a second thing to aim at mid-set on the screen the gym-floor constraints exist for.

**Edit stays visible past the same-day window and surfaces the refusal**, rather than hiding itself. Remove beside it carries the identical window and already reports; a strip where one control hides and the other reports would contradict itself about one rule. Hiding would also need the client to hold a clock — `performedOn` is memoised at mount, so a screen left open across midnight would keep offering an Edit it had no reason to re-render — and the case this decision is about *is* the still-mounted screen at 00:05. The server computes the window from `logged_at` in the client's timezone and is the only thing that can.

**The row swaps element, so focus is managed.** An `<input>` cannot live inside a `<button>`, so editing replaces the row rather than decorating it, and focus left alone falls to `<body>`: a keyboard user is returned to the top of the document mid-workout. Edit puts the caret in the weight field (the first of the two, and the likelier to be wrong); Cancel returns it to Edit; a successful save closes the strip and returns it to the row, which now reads the new numbers. A failed save moves nothing — the fields keep what was typed and the caret stays in the one being corrected.

The **one-time hint** is the other half. #105 put removal behind a reveal and nothing said the row revealed anything, so discovery meant poking a row for no reason. No permanent per-row glyph — DESIGN.md's decoration ban rules out a control on every row for an occasional action — so the affordance is taught once instead: one line of muted text under the first block that has a saved row, dismissed by "Got it" or automatically by opening any row, stored device-locally like the workout draft. It is deliberately **not** a Message: a panel means something happened, and an instruction is not an outcome.)

(Also #48: a "History" link sits on the Today screen's header line. ui-ux.md specifies no navigation chrome, which was about not building a tab bar for five screens rather than leaving screens unreachable — one link is the minimum honest entry point. Its visual treatment is deliberately quiet; revisit if it needs to stand out more.)

### Trainer (5 screens)
| Screen | Content |
|---|---|
| Clients | list + add/deactivate; per-client: last session date (the "who's slacking" signal — the v1 stand-in for the deferred digest) |
| Client detail | their program (edit entry point), their history (sessions → sets, behind a disclosure), reminder schedule (time, days, enabled) |
| New program | title, for a client; creates the draft the builder then fills. `/programs/new?client=` |
| Program builder | rename; status; days → prescriptions; add exercise from library; drag-or-buttons reorder (buttons acceptable in v1; drag is polish); delete the program |
| Exercise library | list/add/edit: name, video URL, cues; soft-delete |

(Client detail's history row is amended by #142. It read "their history" while the screen showed dates and comments only, because no trainer-side route returned a client's logged sets. It now shows sessions that open to what was lifted — the same disclosure the client's own History uses, on the same grouped data, through the same `ExerciseSets` component.

Two things about it are decisions rather than defaults. **The session comment sits on the collapsed row, not inside the disclosure** — database.md calls it the v1 substitute for messaging, so it is the one thing on that list written *to* the trainer, and behind a tap it would be a message nobody reads. That deliberately differs from the client's own History, which puts the comment inside: she wrote the note and knows what it says, so there it is reference; here it has never been seen, so it is the signal. **The disclosure carries a `▾`/`▴` chevron**, because #132 established that weight and ink are hierarchy and cannot also be the affordance. It is not the record link's `›`, which DESIGN.md assigns to "opens a record" — a disclosure goes nowhere, and a third meaning for that glyph would cost the other two their precision. The client's History cards got the same chevron in the same ticket; they had the defect too.)

(The Program builder row gains two entries in #118, and one of them was a gap rather than new scope. **Rename** was specified from the start in everything but the screen: PATCH /api/programs/:id accepted `title`, the SPA's client function passed it through, and the builder rendered the title as a dead heading — so a title mistyped on New program was permanent, and the only correction was to build the program again. That workaround was the same one #118 exists to remove, which is why the rename lands in the same ticket rather than a later one.

**Delete** sits at the foot of the screen, below the days: the action that commits sits at the end of the flow it belongs to, and this one belongs to the whole screen rather than to any block in it. Two things about it are decisions. The prompt does **not** carry the day and prescription prompts' reassurance that logged history survives, because for a whole program that reassurance would be false; the API refuses a program with anything logged against it instead, so the only delete that succeeds here is one nothing points at. And a **successful delete turns the screen into the receipt** — a heading, a confirmation panel and a link back to the client — rather than navigating away. Every other write on this screen is acknowledged in the slot of the block that made it, and this one takes the Days section, the status control and its own cluster with it, so there is no slot left; navigating to the client instead would drop the only acknowledgement of the most destructive write in the builder, and a program that was never in that client's list looks exactly like one just removed from it. That state is held in memory, so reloading the URL lands on the builder's existing "Program not found" screen, which is correct for a second visit: by then the trainer is not being told what happened, they are asking for something that does not exist.)

(New program is added to this table by #138, which found it built and routed but absent from the inventory. It is not new scope — #53 built it as the "Build a program" entry point this table's Client detail row already implies, and a create step has to exist somewhere for the builder to have a draft to open. What was wrong was the inventory, which had been describing four trainer screens while five shipped. Recorded rather than scope-reviewed for that reason.)

(Recorded in #50: trainer screens sit at root-level paths, not behind a /trainer prefix — a session is a trainer's or a client's and never both, so the path sets can't collide. RequireTrainerSession mirrors RequireClientSession; "trainer" is inferred from a valid cookie plus a 404 from /api/me, since no endpoint returns trainer identity. Desktop-first means a wider container (max-w-5xl vs the client screens' max-w-lg) and a relaxed --tap-min per DESIGN.md's carve-out; everything else in DESIGN.md still applies. Only Clients and Exercise library are top-level destinations — client detail hangs off a client, the program builder off that — so the nav bar renders only once there is more than one place to go.

The "desktop-first" half of that note is withdrawn by #135; the container is still `max-w-5xl`, but as the ceiling the layout grows into rather than the width it is designed at. What the four screens owe the revised rule 3:

- **44px is binding here too.** DESIGN.md's carve-out is revoked, not relaxed. One vocabulary module sizes every trainer control, so this is a property of `trainerControls.ts` rather than of any screen.
- **Nothing overflows 390px.** Two things break this if left alone: a fixed-width flex item that cannot shrink, and a bare `<select>`, which sizes itself to its widest option and so is as wide as the longest exercise name or IANA timezone in the list.
- **Long labels move to `aria-label`.** "Retire {name}" is right for a screen reader moving down a library of forty rows and wrong for a 390px card, so the row buttons read "Retire" and carry the naming form in `aria-label`. The accessible name is unchanged, which is why the tests that assert it did not.
- **A table is a wide-case layout.** The roster is still a set of parallel facts compared down a column, and it still gets column alignment where there is room for one. It gets it from a grid that stacks below `sm:` rather than from `<table>`, which cannot reflow at any width.)

(Also #114: trainer controls carry hover and cursor affordances via a shared vocabulary module; focus remains the app-wide :focus-visible outline. Tailwind v4's preflight dropped v3's button cursor: pointer, which was much of what made buttons read as non-interactive. No transitions — adding them is a DESIGN.md decision, not a component tweak.)

Ten screens total (five client, five trainer). If an eleventh appears during build, it goes through PRODUCT.md scope review, not straight into the sprint.

(The count read "nine" until #138. The tenth was New program, above — shipped in #53 and never written down, which is how a screen ends up outside the review this line exists to trigger. The lesson is the ordering: the inventory is what makes a new screen visible as new, so it gets updated in the ticket that builds one, not in an audit two dozen tickets later.)

## Stack & visual decisions

- Tailwind CSS, no component library in v1. (Rejected: shadcn/MUI — 9 screens don't amortize a design system; adding one later is trivial, removing one isn't.)
- Video links open YouTube in a new tab/native app. No embedded player (embed = layout shift + bundle weight for zero logging value).
- Loading states: skeletons on Today/History; none elsewhere.
- No dark mode, no animations, no branding pass in v1. A logo is not on the critical path to the Definition of Shipped.

## Non-goals (v1)

- Progress charts (v1.1 — data model already supports; see database.md)
- PWA install banner / service worker (revisit only if clients ask for "an app icon"; the share-sheet "Add to Home Screen" works today)
- Offline anything
- ~~Trainer mobile optimization beyond "usable"~~ — withdrawn by #135. Trainer screens are mobile-first, on the same terms as the client screens. What stays out of scope is anything the client screens also do without: no touch gestures, no drag-to-reorder (buttons remain the v1 answer), no separate phone layout maintained alongside a desktop one.
- Accessibility audit beyond semantic HTML + label/contrast basics (do the basics; skip the formal pass)
