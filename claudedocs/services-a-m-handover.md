# Handover — `src/server/services/__tests__` a–m shared-mock migration

josh, 2026-08-15. Branch `perf/test-mock-migration-services-a-m`, based on
`perf/test-mock-system`. Everything below is the state at handover plus the reasoning that is not
recoverable from the diff.

## Where it stands

**111 of 129 files migrated, 18 remaining.** (An earlier draft said 112 "once batch 5 lands"; the
verified count after it landed is 111.) The slice's allowlist entries went 169 → 18.
Every landed batch was verified in a single tenancy: per-file collected counts against a control
taken on this branch, zero-collect checked from a `--no-isolate` half, no failure totals compared
across tenancies.

The slice is the allowlist's `files[]` under `src/server/services/__tests__/` (flat, no subdir),
sorted, from `account-deletion-images.test.ts` through `model-version.purge-by-hash.service.test.ts`
inclusive. `blocks/`, `generation/` and `orchestrator/` subdirectories are a different owner's.

## The 17 that remain, by bucket, with the discriminator

**A successor's first question about any unconverted file is which bucket it is in. This is how to
decide, not just what the answer was.**

### Bucket 1 — the entry point defers the client choice to runtime (2 files)

`model-version.blue-buzz-purchase`, `model-version.purge-by-hash`.

**Discriminator:** take the functions the *test file imports*, and ask whether that function's body
reaches `getDbWithoutLag` (directly or through a helper like `getVersionById`). If it does, which
client runs is decided by replication-lag state at call time and **cannot be resolved by reading**.

🔴 **It is worse than undecidable — under test it is decided WRONGLY.** `REPLICATION_LAG_DELAY` is a
zod `.default(0)` key absent from `TEST_ENV_DEFAULTS`, so the canonical env reads `undefined`, and
`undefined <= 0` is `false` where `0 <= 0` is `true`. Every test reaching `getDbWithoutLag` without
stubbing `db-lag-helpers` takes a staleness branch production never takes. See
`services-a-m-parameterised-client-analysis.md`; the fix (seed `TEST_ENV_DEFAULTS` from the schema's
own defaults) is a shared-mock change and was handed to the env lane.

### Bucket 2 — the client is a caller-supplied parameter (6 files)

The `block-registry.*` family plus both `appBlockReview.*` files.

**Discriminator:** the service does `const db = opts.db === 'read' ? dbRead : dbWrite` and passes
`db` down. A grep for `dbRead.<model>.<method>` finds **nothing**, which reads like an unused path
and is actually the tell.

Per-case routing is written up in `services-a-m-parameterised-client-analysis.md`, including all 14
negative assertions and the `:2032` call site whose default is **inverted** relative to the other
four.

### Bucket 3 — the `withSysReadDeadline` seam: UNBLOCKED, and the first three to pick up (3 files)

`collection.service.sysredis-soft`, `content-markdown.sysredis-soft`,
`daily-challenge-service.sysredis-soft`.

Each declares `withSysReadDeadline` in its factory as the seam that drives the timeout
(`mockImplementation((p) => p)` by default, `mockRejectedValue(...)` for the timeout case). Until
`17f994221e` on `perf/test-mock-system`, `setup.ts` spread the **real** implementation into the
canonical factory, so converting them would have deleted the only lever they have.

**That seam is now landed: `redisMock.withSysReadDeadline` is a hybrid node whose default lazily
imports the real implementation.** Both spellings these files already use keep working, and
`resetHybridNodes` restores the real one per file. **Rebase onto that commit or later, and these are
the three easiest remaining files.**

⚠️ **The check afterwards is NOT "do they pass".** Confirm for each: the injected implementation is
actually **reached** (assert the spy was called, not merely that the file is green), and a per-file
rejection still produces the timeout branch. **A seam that silently resolves everything passes both
a conversion and a run.**

🔴 **And do not migrate `src/tests/api/health.runHealthChecks.test.ts` as part of this.** It advances
a fake clock 2,500 ms against a never-settling `sysRedis.ping`, and it is safe only while the health
check's own 1,000 ms per-check timeout stays **below** `REDIS_SYS_READ_TIMEOUT_MS` (2,000). Two
numbers with nothing connecting them; raise the first for an unrelated reason and the hazard goes
live in a file nowhere near the change.

### Bucket 4 — ordinary hand work (7 files)

`coinbase.service`, `commentsv2.appListing.service`, `commentsv2.blockCheck.service`,
`model-early-access-refund.service`, `model-version.deregister.service`, `model-file.service`,
`model-file-scan.service`.

**These plus bucket 3 are what a successor can pick up cold.** `coinbase` has a `$transaction` with
a multi-statement body; the two `commentsv2` files alias one local across both clients and thread a
`tx` object; `model-early-access-refund` has a `$transaction` handing the callback its own `tx`.
Resolve each by entry point the way `engagement-toggle` was resolved — that one turned out to hide a
genuine read/write split, so do not assume an alias is a renaming.

### Bucket 5 — migrated but permanently isolated (1 file, already counted as done)

`bust-public-model-response-cache` sets `IS_DATAPACKET: true` at module scope, which
`model-version.service:2442` reads at import. **Its canonical mocks are converted and the allowlist
correctly shows it clean — but it can never join the `unit-fast` project.** Four files repo-wide are
in this class and disagree on the value; this is the only one in services. A readiness measure of
"no direct canonical mocks" will read it as eligible when it is not.

## The tool, and the refusal each case taught it

`scripts/test-perf/bind-client-locals.mjs`. **It now auto-converts 0 of the remaining files — that
is the honest number, not a regression.** Every refusal below was added after catching the tool
wrong on a real file:

| refusal | the case that taught it |
|---|---|
| leaf carrying non-default behaviour, extracted with **balanced parens** | a lazy `vi.fn\([^;]*?\)` stops inside an arrow's own parameter list and hands the check a truncated call that reads as behaviour-free; it cleared five files it existed to stop |
| leaf that is a **bare identifier declared elsewhere** | `minor-hash` — deleting the client literal left two spies alive, armed by `beforeEach`, wired to nothing, and the primary-vs-replica re-read got the canonical `null`. **Behaviour-free is not the same as safe to delete** |
| one local bound to **both** clients | binding it twice picks whichever came last, silently choosing a client — the collision the split exists to surface |
| **ES6 shorthand** (`{ groupBy }`) | parsed as no entries, so a spy declared elsewhere was silently orphaned |
| factory with a **block body** | `() => { … return { … } }` opened on the block's brace, read an empty object, found no exports to object to, and **deleted the whole factory with every local it named**. Caught by reading a diff, not by any check |

## Two constraints on the mock system itself

**Neither is about this slice, and neither is documented anywhere else.**

🔴 **A canonical mock cannot statically import anything that reads mocked env at module scope.**
`redis.mock.ts` is loaded from `setup.ts`, which is *earlier* than every hoisted `vi.mock` factory
setup registers — so a static `import` of a module whose own top level reads `env` evaluates before
the env mock's factory has initialised. The failure is
`ReferenceError: Cannot access '__vi_import_N__' before initialization`, and it presents as
**zero tests collected reported as one failed suite** — the shape that has cost this project the
most. Use a lazy `await import(…)` inside the default implementation, cached. (Found by sky adding
the `withSysReadDeadline` seam; the import was entirely reasonable.)

⚠️ **`pnpm run typecheck` on this base returns ~25 errors that are not yours.** They sit in
`placement-*`, `cosmetic-*`, `feedback-*` and `grok.config.ts` — a worktree predating a dependency
bump and `db:generate` (`Placement.spendType`, `Cosmetic.pHashHex`). **The tell is errors in files
you did not touch.** Read the file list before believing any of them are yours; running
`db:generate` fixes it and is box work nobody needs for a test-file change.

## Recipes that worked, in the order they come up

1. **Resolve the client by the entry point the TEST imports**, never by scanning the whole service
   module. `BOTH` from a module scan is an unanswered question, not a verdict.
2. **Re-point leaf identifiers**, do not delete them with the literal that wired them up.
3. **Re-state any fixture the canonical mock has no default for** — `create`/`update`/`delete`
   return `undefined` by default, and several services read what they return.
4. **`$transaction` is safe to inherit only when the old fixture's `tx` and `dbWrite` were the same
   object** (a spread). Where `tx` was separate, inheriting the canonical default collapses
   in-transaction and direct calls, and an assertion meaning "written outside the transaction"
   starts passing for the wrong reason. `model-appeal` keeps its own `tx` for this reason.
5. **Drifted `REDIS_KEYS` copies get swapped for the real constant silently.** Diff the dropped
   string literals; the codemod's own drift report is a lower bound (4 named, 9 real, on this slice).

## What I re-derived after the tooling scare, and what I did not

Three categories, because two would be misleading:

**Re-verified explicitly after the shell-`grep` warning:** the 4-of-12 entity-type count in
`commentsv2-owner` (re-run through the structured tool, identical answer); both of my own claimed
instances of the grep bug (**one was a correct negative I misread; one does not reproduce and is
filed as unexplained**); the pipe-vs-redirect counting boundary (reproduced here — a piped `wc -l`
counts the `[rtk]` banner, a redirect does not).

**Structurally immune, not re-checked line by line:** every load-bearing claim came from a node
script or the structured Grep tool — residual counts, dropped-literal drift, the orphaned-leaf-spy
scan, the mutation scan, the env-mock sweep, the `IS_DATAPACKET` set, the 73/59/40 zod-default
counts. **That is an accident of format, not a method** — I wrote node because I wanted structured
output, and it would not have saved me if my checks had been one-liners.

**Not re-derived, and flagged as such:** the 27 cases of `block-registry.resolve-instance` were not
read individually — the entry point and its default were resolved, the cases were not. And
`appCollaborator.findMany` in `appBlockReview.collaborator-self-review` appears on neither client in
the service source; **I could not resolve it and did not guess.**

## The one rule I would put above the others

**"I could not determine it" and "it cannot be determined" are different statements**, and the first
is much cheaper to write while looking identical in a doc. I filed three files as permanently
unresolvable that resolved on a second reading — in the same commit as a section warning against the
mistake I was making. **Every "blocked", "permanent" and "cannot be measured" in this handover
deserves that question asked of it once more, including the ones I still believe.**
