# farooq-erp-next

Rebuild of the Farooq & Co Traders ERP (currently live at `erp.farooqandcotraders.online`, a vanilla-JS/
IndexedDB app in the `projectFarooqAndCoTraders` repo) on NestJS + TypeScript + PostgreSQL + React.

This is a **planning-hub-driven, multi-session build**. See `CLAUDE.md` for the rules and stack, and
`docs/STATUS.md` for current state. Nothing here is deployed anywhere yet — the live ERP remains the system
of record until modules are cut over one at a time.

## Workflow

- A separate "planning hub" session writes `docs/sessions/S<N>.md` plans and reviews results.
- Each implementation step runs in its own fresh session, started with:
  `Implement docs/sessions/S<N>.md — follow CLAUDE.md, then update docs/STATUS.md and push.`
- Implementation sessions write what they did to `docs/STATUS.md` and push. That file (plus the git log) is
  how the planning hub picks up the next step — no chat memory is required between sessions.

See `docs/ROADMAP.md` for the milestone list and `docs/PARITY.md` for the legacy-module checklist.
