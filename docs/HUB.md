# How the planning hub works (read this if you are the planning-hub session)

This repo is built in **sessions**. A **planning hub** plans and checks; **implementation sessions** build.
All state lives in this repo. No session remembers another, so this file, `docs/STATUS.md`, `docs/ROADMAP.md` and `docs/PARITY.md` are the whole hand-off.
Written 2026-09-26 by the hub that planned M3; update it when the loop changes.

## Who does what
- **The planning hub** is opened in `D:\projectFarooqAndCoTraders`, the live ERP's repo, so that its memory note about this project loads. Any hub session can take over, because nothing lives only in its head. The hub:
  - writes session plans (`docs/sessions/S<N>.md`);
  - checks each finished session;
  - keeps ROADMAP / STATUS / PARITY straight.
  - It **never builds the app** and commits **only docs**. The one exception is the rule under "When a session ends without committing".
  - Plan a new milestone in plan mode with the strongest model: it is design-heavy (money, stock, cost). The routine "S<N> done → check → finalise the next plan" loop needs less.
- **An implementation session** is a fresh session opened in `D:\farooq-erp-next` and started with exactly:
  `Implement docs/sessions/S<N>.md — follow CLAUDE.md, then update docs/STATUS.md and push.`
  It follows `CLAUDE.md` in this repo, moves its write-up to `docs/history/S<N>.md`, updates STATUS, pushes, and records CI.

## The loop (the user says "S<N> done")
1. **Read-only checks, in this repo:**
   - `git fetch`, then `git status` (it must be clean) and `git log origin/main`;
   - `gh run list`: the session's commit must be **completed / success**. "In progress" is not green.
   - Then read `docs/history/S<N>.md` (verification numbers, mutation checks, deviations, findings) and STATUS "Next step".
2. **Check the old ERP for changes:**
   - `git -C D:\projectFarooqAndCoTraders log --since=<last check> origin/main -- public_html/ERP`.
   - Every commit there must have a line in `docs/PARITY.md` → "Change log". The old repo's own `CLAUDE.md` asks its sessions to add it.
   - Also read the old repo's `CLAUDE.md` for things that are not code, such as the **2026-09-25 data wipe**.
   - A change that alters a figure this repo already computes gets a catch-up session **before** the next feature session. S14 is the model.
3. **Look for what is weak, not just what is green.** Ask:
   - Was any mutation green on its first run? (S12's M34 turned out to be a half-tested rule.)
   - Was a real-data proof empty?
   - Did the session leave a "decide this later" for the next plan?
4. **Finalise the next session file:**
   - Change its banner from DRAFT to **Final**.
   - Add a "Planner decisions after S<N> (binding)" section that settles every open point.
   - Ask the user with AskUserQuestion when a point is theirs to decide; recommend an option.
5. **Commit and push only the docs you changed.** Update the memory note `reference_farooq_erp_next_rebuild.md` in the hub's memory folder.
   - Hand the user the one-line prompt above.
   - Waiting for CI on a docs-only commit is optional; waiting on code changes is not.

## Planning a new milestone
- **Read first:** STATUS (rules in force), ROADMAP (the milestone's line), PARITY (legacy module rows, the "money-critical rules" list, the change log), the legacy modules named there, and the real backup counts.
- **Draft the breakdown the way M2 and M3 went:**
  1. data + import + reconciliation first (proves the import is exact on real data);
  2. then the service + API with a **ledger bridge** (scripted operations mirrored on the legacy JSON, reconciliation 0);
  3. then read screens;
  4. then the entry screen, which closes the milestone.
- **Decisions:** collect the owner / user decisions with AskUserQuestion before writing session 1. Legacy bugs are **fixed, not ported**, each with a test and a line in the owner-visible list.
- **Session files:** the first file is Final, the rest DRAFT. Each implementation session corrects the next file ("What S<N> actually built" / "Corrections after S<N>") before the hub finalises it.

## Rules the hub has learned (keep them)
- **"Done" for money means reconciliation shows 0 differences on real data**, not that tests pass.
- **Real data:**
  - The **real-data reference set is pinned by name**: v692 and v710, the last nightlies before the live test data was wiped on 2026-09-25. See `realBackups()` in `@farooq/db/testing`. Never "the newest file".
  - Newer nightlies are fetched read-only (`ssh -p 65002 u943531942@31.97.219.57 'ls -t ~/backups/nightly/'`, one `scp` into the gitignored `data/`) and join as the "current" dataset.
  - Real data never goes in git, and never gets quoted as rows: counts only.
- **When a session ends without committing** (it happened with S11): with the user's OK, the hub re-runs the full `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` once. If it is green, the hub commits exactly what the session left, pushes, and records CI. A single flaky browser test is rerun on its own and named in STATUS.
- **No person walkthrough gate** (cancelled by the user on 2026-09-26). STATUS keeps a "Not yet seen by a person" list as information for before any cutover.
- **Never deploy; never touch the live ERP or its database from this project.** Hosting is undecided (STATUS open question).

## Where things are
- `docs/STATUS.md`: current state only.
- `docs/history/`: verbatim write-ups. Grep them; don't read them end to end.
- `docs/ROADMAP.md`: milestones and session tables.
- `docs/PARITY.md`: legacy checklist, rule → test tables, old-ERP change log.
- `docs/sessions/`: plans.
- The live ERP's repo: `D:\projectFarooqAndCoTraders` (`public_html/ERP/erp-upgrade/*.js` = the legacy modules; its `CLAUDE.md` = live rules and recent changes).
