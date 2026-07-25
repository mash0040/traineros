# TrainerOS — agent entry point

Read in this order before doing anything:

1. **PRODUCT.md** — v1 scope, non-goals, and the Definition of Shipped. This is the boundary of what gets built.
2. **docs/** — the design decisions: `architecture.md` (stack, repo layout, deployment), `database.md` (schema), `api.md` (routes and the authorization model), `notifications.md` (reminder pipeline), `ui-ux.md` (screens).
3. **DESIGN.md** — the visual system for the client: OKLCH tokens, typography, layout, absolute bans. Consumed by anything that touches `src/web/`.
4. **.claude/rules/** — coding and workflow conventions, starting with `conventions.md`.

**The rule:** never invent scope not in the specs; if a spec is silent, stop and ask.

## Design Context

`docs/ui-ux.md` governs scope (what gets built); `DESIGN.md` governs taste within it (how it looks). Where they conflict — component libraries, motion, dark mode — **ui-ux.md wins**. DESIGN.md may not silently reintroduce anything ui-ux.md has scoped out; that is a PRODUCT.md scope question, not a design freedom.
