# claudedocs/ Audit — 2026-08-21

**Status:** acted on. Every item below was either fixed and merged (#4280, #4281, #4282) or
filed as tracked work; measured against `main` at `312a91ad7c`, outcomes recorded 2026-08-22.
This document is kept because **how the first pass got it wrong** is the reusable part.

**Scope:** 11 files in `claudedocs/` · assessed for staleness, outstanding work, and cleanup.

---

## The failure mode this audit is really about

The first pass got **6 of 11 statuses wrong, all in one direction**: it read each doc's
_self-reported_ status instead of re-checking the repository, so anything that had moved since
its doc was written stayed on the list unmoved.

That is the finding worth keeping. A status line that does not name what it was true _at_
cannot be re-verified, only re-trusted — and these documents are read as authoritative. The
convention that came out of it now lives in `claudedocs/README.md` (#4280).

### Method that corrected it

Every claim was re-checked against the repo, never against the doc asserting it: PR state via
`gh pr view --json state,mergedAt`; file state by reading the current file; presence of a gate
by grepping for its **callers**, not its definition.

The PR-merge lookups in the first pass were all correct. The errors were entirely in the items
where **no lookup was done**.

---

## The six corrections

**1. Turbopack — wrong on all three counts.**
First pass: _"upgrade to Next.js ≥16.3.0 (not yet released). Blocked until the dep lands."_
`package.json` already read `^16.3.1` (landed in #4075), and the doc itself carries a section
headed _"Next 16.3.1 is a re-roll, not a fix"_ — hash width, first-character bias, largest
namespace and chunk count are all measurably unchanged on it. The doc predicts exactly this
misreading, and the first pass made it. Two items in its Options list were unblocked work, one
explicitly labelled _"not a wait"_.

**2. Typecheck gate — "never merged" was false.**
#3868 merged 2026-08-13; #4189 extended it 2026-08-20. The first pass was misled by #3868's
literal title, `PROPOSAL (do not merge)`. 🔴 The real defect is different and worse: **nothing
invokes it.** No `package.json` script, no workflow reference — the ratchet fires on nothing
while reading as done. Recorded in that doc's status line (#4280) and on the tracking card.

**3. Services a–m allowlist — "needs cleanup" was false.**
The allowlist is generated and was already correct at #3973's merge commit; its a–m content was
byte-identical then and now. Five entries, not 127. **The real remaining work — 37 n–z files —
went unmentioned by the first pass entirely.**

**4. App Blocks flake — half of it was already fixed.**
`AppListingsMarketplaceBody` was fixed by #3654, merged the _same day_ the RCA was written; the
RCA was never updated and still said `(NOT fixed)`. The `PageBlockHost` half is genuinely live.

**5. The archivability premise was wrong twice.**
_"These cost tokens on every agent that loads them"_ — `claudedocs/` is **not** auto-loaded; no
`@` import exists in `CLAUDE.md`. And `app-blocks-host-handler-parity-2026-06-29.md` is cited
from live source at `src/components/AppBlocks/PageBlockHost.tsx`. Archiving it would have broken
a code pointer. **Four of the eleven docs are referenced from outside themselves.**

**6. `test-perf-measurement-envelope` was misfiled** as incomplete work. One item is outstanding;
the rest is standing methodology — and its closing line, _"a measurement passing because the
thing being measured never happened"_, is precisely what happened to items 1 and 2 above.

---

## Outcomes

| Item                                                | Outcome                                               |
| --------------------------------------------------- | ----------------------------------------------------- |
| Status-line convention + 11-doc sweep               | **merged** — #4280                                    |
| `TEST_ENV_DEFAULTS` derived from the env schema     | **merged** — #4281                                    |
| Services n–z, first 6 of 37                         | **merged** — #4282                                    |
| Wire the merged typecheck gate into CI              | open — the gate exists and runs nowhere               |
| PageBlockHost flake, 4 sites                        | blocked — the browser tier cannot launch on this host |
| Turbopack: builder-RSS measurement + upstream repro | open                                                  |
| Clean unit-suite drift pair                         | open — needs a quiet box, not an agent                |
| Archive anything                                    | **not done, deliberately** — see correction 5         |

### What #4281 turned up, which no audit predicted

Deriving the test env from the schema turned one suite red:
`get-orchestrator-token.sysredis-soft`. `ORCHESTRATOR_MODE` was **absent** from the
hand-enumerated defaults, so it read `undefined` and left this branch dead:

```ts
if (env.ORCHESTRATOR_MODE === 'dev') token = env.ORCHESTRATOR_ACCESS_TOKEN;
```

With the env corrected the branch went live and the function began returning a static token
without touching sysRedis at all — including on the fail-on-revert case whose whole purpose is
that a never-settling `hGet` must not hang the caller. **That suite was never testing the
deadline wrap; it was testing a path it reached only because the test environment was wrong.**

A local two-arm control over three files said "nothing moved". It was sound and its sample was
too narrow; CI is what found this. Worth remembering when a control comes back clean.

---

## Still open, unowned

- **`direct-mock-allowlist.json` is stale by ~37 pending files.** The ratchet refuses growth on
  the _canonical_ half only, so the pending half drifts per-PR with nothing noticing.
- **31 n–z files remain**, plus `paid-access.service`, whose redis mock needs doing by hand.
- **#4281's allowlist goal is unmet** — both converted files still mock the redis client
  directly, so they do not drop out.
- **The component-test tier may have no working environment anywhere.** If CI cannot run it
  either, "no main-branch signal" is a consequence rather than a coincidence. Unverified.

---

## Note on this document's own history

The corrected version of this audit was written on 2026-08-21, reported as done, and **never
committed**. It was untracked and was gone by the following day; the analysis survived only
because it had been copied into task cards and PR descriptions.

That is the same class as the defect this audit is about — a claim recorded somewhere that
cannot be checked later — and it is why the file is now tracked.
