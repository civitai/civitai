# Handover — `src/server/services/__tests__` a–m shared-mock migration

josh, 2026-08-15, continued and closed out by liz through batches 6–9 (her sections are marked).
Kept as a LOG rather than rewritten to current state: which claims were superseded, and by what, is
the thing a successor most needs — josh's *"the three easiest remaining files"* with the ✅ beneath
it is a corrected prediction, and a corrected prediction is evidence about the method. Branch
`perf/test-mock-migration-services-a-m`, now based on `perf/test-mock-system` at `17f994221e` — the
`withSysReadDeadline` seam commit. Everything below is the state at handover plus the reasoning that
is not recoverable from the diff.

## Where it stands

**127 of 129 files migrated, 2 remaining — the slice is done apart from the two lag-selected
hold-outs.** (liz, after batches 6–9.) josh's count at handover was 111 of 129, and it was right; an
earlier draft of his said 112 "once batch 5 lands", which the verified count corrected to 111.

Every batch below was verified the same way: a control and a candidate in ONE box tenancy, per-file
collected counts, a `cmp` gate before the control half proving it is not a second copy of the
candidate, and a probe that had to FAIL. No claim here rests on a failure count or a timing delta at
any width — those are not instruments under `--no-isolate` (96 / 379 / 121 failures on an identical
tree, same tenancy, elise 2026-08-15).

| batch | files | result |
|---|---|---|
| 6 | 3 `withSysReadDeadline` seam | 4/4/4 both halves, 3/3 predictions |
| 7 | 6 ordinary (bucket 4 minus `model-file-scan`) | 22/7/4/11/22/4 both halves, 6/6 predictions |
| 8 | `model-file-scan` (1,439 lines) | 66 both halves, matching a static prior stated first |
| 9 | 6 parameterised-client | 11/17/14/4/27/15 — **4/6 predictions; see the red below** |

⚠️ **129 is the count of files that EVER carried a direct canonical mock, and it is not the count of
files in the directory.** Re-derived independently off the allowlist at the branch base
(`git show <base>:src/__tests__/mocks/direct-mock-allowlist.json`), which confirms josh's figure and
makes it checkable rather than inherited:

```
files ON DISK in the a-m range (flat dir, through purge-by-hash)   170
  ever carried a direct canonical mock                             129   <- the denominator
    still carrying one                                               2
    converted                                                      127
  never carried one — not work, and not progress                    41
```

🔴 **So "files with no direct canonical mock" over-reports by 41 files at every point in this
migration** — at the time this table was first written it read 155 of 170, 91%, against a true
114 of 129.
The 41 were never work. Anyone measuring this slice by absence gets the flattering number, and it is
the one that is easier to compute. Same shape as `fast-eligible` on `blocks/` (39 of 56 mock nothing;
earned number 17) and the `unit-fast` manifest (439 of 443 mock nothing; earned 4) — **three
independent instances, all inflating in the same direction.** It is a property of measuring migration
progress by absence, not a caveat about one metric.

The slice is the allowlist's `files[]` under `src/server/services/__tests__/` (flat, no subdir),
sorted, from `account-deletion-images.test.ts` through `model-version.purge-by-hash.service.test.ts`
inclusive. `blocks/`, `generation/` and `orchestrator/` subdirectories are a different owner's.

## 🔴 The red, and the routing table that caused it — read this before trusting any inherited table

Batch 9's first candidate half went **red on 2 of 6 files**, six tests, every one
`AssertionError: expected null not to be null`. The cause was a line in
`services-a-m-parameterised-client-analysis.md`, taken as evidence rather than as a claim.

`resolveBlockInstance` (`block-registry.service:1354`) takes its client as a parameter at `:1362`
and then uses that local for **everything on the path**:

```
:1409   db.blockUserSubscription.findUnique
:1451   db.model.findUnique
:1461   db.modelVersion.findFirst
```

The analysis says *"`model.findUnique` resolves to `dbRead` in the service source directly"*. **It
does not — not on this path.** The `dbRead.model.findUnique` spelling it cites is at `:2617`, in a
function these tests never call. Routing `model` / `modelVersion` to dbRead made the code read the
canonical `null` on a client it never touches, and `if (!model) return null` fired everywhere.
Fifteen sites corrected to dbWrite; green after.

🔑 **This is the fourth `BOTH`-off-a-whole-module-scan instance in this slice and the first to reach
a routing TABLE rather than a bucket assignment.** josh's own rule caught his; the analysis's own
warning did not catch the analysis. **A citation was present, it looked checked, and the cited line
was not on the path.** The aggravating detail is that the analysis is otherwise excellent and its
per-case table is right everywhere else — a document that is right 95% of the time is more dangerous
than one that is obviously rough, because trusting it is easier.

**So: for a parameterised entry point, the question is not "where is this table spelled" but "does
this call go through the parameterised local".** If it does, one default decides every table on that
path at once.

## 🔑 A mis-routed negative is silent — demonstrated, with the control that makes it mean something

Batch 9's probe, three mutations in one run:

| | mutation | observed |
|---|---|---|
| **A** | the two DANGEROUS negatives (`appBlockPublishRequest.findFirst`) mis-routed to dbRead | **PASSED** |
| **B** | three SAFE negatives (`appBlock.update`, dbWrite-only) mis-routed the same way | **PASSED**, 14/14 |
| **C** | the dangerous one asserted POSITIVELY on dbWrite, where the code does not call it | **FAILED** |

**A and B both passing is the result.** A passing mis-route carries no information, because the safe
case passes identically — so only **C** discriminates, and it is the only evidence available for the
two assertions no static check can resolve. Without B you show the technique fires; with it you show
it separates.

⚠️ **Free win, worth knowing before you write an assertion:** the hybrid node carries its dotted path
as its `mockName`, so a failure reads `expected "dbWrite.appBlockPublishRequest.findFirst"` where the
old hand-rolled fixtures read `expected "spy"`. **A mis-route now names the client it landed on.**
The migration improves failure legibility, not only isolation.

## The 2 that remain, by bucket, with the discriminator

**A successor's first question about any unconverted file is which bucket it is in. This is how to
decide, not just what the answer was.**

### Bucket 1 — the entry point defers the client choice to runtime (2 files)

`model-version.blue-buzz-purchase`, `model-version.purge-by-hash`.

**Discriminator:** take the functions the *test file imports*, and ask whether that function's body
reaches `getDbWithoutLag` (directly or through a helper like `getVersionById`). If it does, which
client runs is decided by replication-lag state at call time and **cannot be resolved by reading**.

⚠️ **A `vi.mock('~/server/db/db-lag-helpers', …)` in the test is NOT the pin it looks like — check
what the mock REPLACES.** The parameterised-client analysis notes the already-converted files were
safe because they mock that module directly; that is true of *those* files and does not generalise.
`model-version.purge-by-hash` and `model-version.deregister` both carry such a mock and neither is
pinned by it — both use `importOriginal` and override **only `preventModelVersionLag`**, leaving
`getDbWithoutLag` real. `model-early-access-refund` is the pinned shape
(`getDbWithoutLag: vi.fn(async () => mockDbRead)`). **So the discriminator is "does the mock replace
`getDbWithoutLag`", not "does the file mock `db-lag-helpers`".** Checked 2026-08-15; `purge-by-hash`
stays in this bucket.

🔴 **It is worse than undecidable — under test it is decided WRONGLY.** `REPLICATION_LAG_DELAY` is a
zod `.default(0)` key absent from `TEST_ENV_DEFAULTS`, so the canonical env reads `undefined`, and
`undefined <= 0` is `false` where `0 <= 0` is `true`. Every test reaching `getDbWithoutLag` without
stubbing `db-lag-helpers` takes a staleness branch production never takes. See
`services-a-m-parameterised-client-analysis.md`; the fix (seed `TEST_ENV_DEFAULTS` from the schema's
own defaults) is a shared-mock change and was handed to the env lane.

### Bucket 2 — the client is a caller-supplied parameter: DONE (6 files, batch 9)

The `block-registry.*` family plus both `appBlockReview.*` files.

**Discriminator:** the service does `const db = opts.db === 'read' ? dbRead : dbWrite` and passes
`db` down. A grep for `dbRead.<model>.<method>` finds **nothing**, which reads like an unused path
and is actually the tell.

Per-case routing is written up in `services-a-m-parameterised-client-analysis.md`, including all 14
negative assertions and the `:2032` call site whose default is **inverted** relative to the other
four.

### Bucket 3 — the `withSysReadDeadline` seam: DONE (3 files, batch 6)

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

✅ **Done and verified, 2026-08-15 (liz).** Control and candidate in one tenancy, per-file:
`4 / 4 / 4` collected, all green, both halves — 0 lost, 0 gained, 0 newly red. "Reached" is asserted
four times per file and is not inferred: each case asserts the seam was called once, and after
conversion that spy IS the node `setup.ts` hands the service.

🔑 **And the harder half — a probe that establishes the timeout leg can go red AT ALL. Do not use a
pass-through.** The obvious probe is to replace the SLOW case's injected rejection with
`mockImplementation((p) => p)`. That is wrong, and it looks reasonable: the never-settling read is
then awaited directly, so the test rides to the 60s `testTimeout` rather than failing. **A probe whose
failure mode is a hang cannot demonstrate that a guard fails fast**, which was the whole question.

Use `mockResolvedValue`, which fails on a **value**:

| file | probe | observed |
|---|---|---|
| `content-markdown` | seam resolves the frontmatter | `promise resolved "{ title: 'Region Warning', …}" instead of rejecting` — **7.1 ms** |
| `collection` | seam resolves `'12345'` | `expected 12345 to be 496339` — **9.6 ms** |

Both fail *specifically because the timeout branch was not taken*, and the mutation is surgical —
exactly one test per file reds, the other three stay green, so it is not a file-wide break that would
fail for any reason. **`daily-challenge` is deliberately NOT probed**: its fail-open collapses a
resolved non-JSON string to `null` as well, so the probe cannot distinguish the branches there. An
ambiguous probe is worse than none.

🔴 **And do not migrate `src/tests/api/health.runHealthChecks.test.ts` as part of this.** It advances
a fake clock 2,500 ms against a never-settling `sysRedis.ping`, and it is safe only while the health
check's own 1,000 ms per-check timeout stays **below** `REDIS_SYS_READ_TIMEOUT_MS` (2,000). Two
numbers with nothing connecting them; raise the first for an unrelated reason and the hazard goes
live in a file nowhere near the change.

### Bucket 4 — ordinary hand work: DONE (7 files, batches 7 and 8)

`coinbase.service`, `commentsv2.appListing.service`, `commentsv2.blockCheck.service`,
`model-early-access-refund.service`, `model-version.deregister.service`, `model-file.service`,
`model-file-scan.service`.

**With bucket 3 done, these are what a successor picks up cold.** Resolve each by entry point the way
`engagement-toggle` was resolved — that one turned out to hide a genuine read/write split, so do not
assume an alias is a renaming.

**Scoped 2026-08-15 (liz), every routing claim with a `service.ts` line.** Intended as batch 7 =
files 1–6, batch 8 = `model-file-scan` alone (1,439 lines, larger than the other six combined).

- 🔴 **`commentsv2.appListing` splits per CASE, not per path.** `db.thread.findUnique` is driven by
  four entry points that disagree: `getCommentCount` `:433` and `getCommentsInfinite` `:741` are
  **dbRead**; `upsertComment` `:267` and `toggleLockCommentsThread` `:471` are **dbWrite**. And
  `togglePinComment` reads on `dbRead` `:505` and writes on `dbWrite` `:508` inside one case. Every
  assertion in the file is positive, so a mis-route is **visible** — route `thread.findUnique`
  uniformly to `dbRead` and the lock case reds on `lastWhere(db.thread.update)` being `{}`.
- **`commentsv2.blockCheck`** — `image.findUnique` **dbRead** (`:172`, via
  `throwIfBlockedByEntityOwner` at `:265`); `thread.findUnique` **dbWrite** `:267`;
  `commentV2.findUnique` **dbWrite** `:279`.
- **`model-file.service`'s local is named `mockDbRead` and serves writes.** `count` `:599`,
  `findFirst` `:617` and `findMany` `:36` are **dbRead**; `findUnique` and `update` are **dbWrite**
  via `markFileReplaced` `:334`/`:347` and `restoreReplacedFile` `:368`/`:382`. ⚠️ The file's own
  comment says *"these official-file helpers only touch dbRead"* — **true of the two functions it was
  written for and false of the file as it now stands.** Delete it with the conversion; a stale comment
  that reads as a routing fact is worse than none.
- **`model-version.deregister`** — `deleteVersionById` `:1047` is **dbWrite only**, so the `dbRead`
  half of its alias is dead.
- **`model-file-scan`** — everything is **dbWrite** except `rescanModel`'s `modelFile.findMany` at
  `:616`, which is **dbRead**. One line decides that file's alias.

**`$transaction`, checked per file rather than pattern-matched** (recipe 4):

| file | shape | inherit the canonical default? |
|---|---|---|
| `coinbase.service` | tx member **is** `mockDbWrite.redeemableCode`, and the service touches only `tx.redeemableCode.create` `:248` | **yes** |
| `model-version.deregister` | `wireTransaction()` is already `cb(mockDbWrite)` | **yes** |
| `commentsv2.blockCheck` | `tx` a separate object; every assertion is on `db.tx.*`, i.e. *"inside the transaction"* | **no — keep a local `tx`** |
| `commentsv2.appListing` | same | **no** |
| `model-early-access-refund` | `mockTx` is a fresh `mk()`, not `mockDbWrite.model` | **no** |

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

## Two instruments that will mislead a successor

⚠️ **`scripts/test-perf/residual-mocks.mjs` only matches `~/` spellings.** Its `pattern()`
interpolates the `~/…` specifier directly, so a file mocking `../../db/client` reads clean through
it. The relative-path hole was closed for the codemod, the guard and the allowlist generator at
`92f1728652` and **not for that script**, which is the one the recipe tells everyone to run. Nothing
on this slice spells them relatively, so no result here is affected — but it is one specifier
spelling behind the rest of the machinery.

Separately, and this is the discipline half rather than a tool bug: **run it PER FILE over your
converted set and print the items.** The default total cannot distinguish "these sites belong to
hold-outs" from "a file I converted is still mocking something". Batch 6's set total and its
per-file listing agreed; the point is that they need not.

🔴 **`numTotalTestSuites` in vitest's JSON report is NOT a file count.** It counts file-level **and**
describe-level suites, so three files with one `describe` each report **6**. A reconciler comparing a
per-file line count against it fires a mismatch on a perfectly healthy run — which is how a correct
instrument gets thrown away. The independent predicate is **"the files reported are the files I asked
for, by name"** plus summed tests against `numTotalTests`.

Worth holding beside its inverse, found the same afternoon: a per-file differ anchored to `src/` was
blind to the 9 of 1,066 files under `scripts/`, and because both halves were **identically blind**
its diff was clean by construction and every published number was correct. **Same symptom, opposite
fault — instrument right / predicate wrong, and instrument wrong / answer right. When the two
disagree you do not get to guess which.**

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

🔴 **…and grep the constant's NAME, never its VALUE. Assume every use site composes it.** A
literal-grep classification of "where is this constant used" is a lower bound on this codebase, it
fails silently, and it fails in the reassuring direction — "0 sites, fixture-only" is exactly what it
reports for a constant used everywhere. Four instances now:

| constant | how production uses it | a literal grep would report |
|---|---|---|
| `cp:banked` (`creator-program`) | `` `cp:banked:${userId}` `` | 0 — it was 6 sites and 3 red tests |
| `REDIS_KEYS.MODEL.GALLERY_SETTINGS` | `` `${…}:${id}` `` ×3, `model.service.ts:2098/:3574/:3977` | 0 |
| `REDIS_SYS_KEYS.WEBHOOKS.MODEL_FILE_SCAN_PROCESSED` | `` `${…}:${event.workflowId}` ``, `model-file-scan.service.ts:474` | 0 |
| `REDIS_SYS_KEYS.CONTENT.REGION_WARNING` | passed whole, `content.service.ts:203` | 1 (the case where it works) |

The middle two are byte-identical to the real table and so cost nothing — **that is luck, not a
result.** Two genuine drifts found on this slice, both inert, both cleared by reading every use
rather than counting them: `content-markdown`'s `'content:region-warning'` against the real
`'system:content:region-warning'` (`client.ts:2026`), and `model-file.service`'s
`'files-for-model-version'` against `'packed:caches:files-for-model-version-2'` (`client.ts:2100`,
and its only use is the `key:` of a `createCachedObject` config whose factory is itself mocked). In
both cases the conversion changes no behaviour, and **that is the finding rather than a footnote:
those files were never asserting the key.**

6. **`$transaction` has TWO branches in the canonical default and recipe 4 documents one.** The
   callback branch runs `arg(client)`; the **array** branch runs `Promise.all(arg)`. A fixture like
   `model-file-scan`'s bare `vi.fn()` against the array form at `model-file-scan.service.ts:212`
   returns `undefined` today while the array's elements are evaluated as it is built — so the
   delegate spies are called either way and inheriting is compatible. Compatible, but the callback
   rule does not tell you that; check the array case on its own.

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

---

## Landing state — read this first if you are inheriting the slice (liz, 2026-08-15)

**The work is on a branch and in a PR. Nothing is half-applied anywhere.**

```
branch  perf/services-a-m-mock-migration @ 632a3da432   (pushed)
PR      #3973, base perf/test-mock-system — DELIBERATELY NOT main
base    perf/test-mock-system @ 935de0e909 at the time of the rebase
        27 commits, 134 files, +2658 / -3372
```

⚠️ **The stale remote `perf/test-mock-migration-services-a-m` @ `19e95f05b5` was left alone.** It
predates the rebase and its history diverges from the PR branch. A `--force-with-lease` would have
been harmless — no PR was ever opened on it — but a new branch was preferred because
**non-destructive beats harmless**. Do not assume the two branches are related by fast-forward.

**Two of the files in this slice are ALSO on `perf/test-mock-system` directly**, at `e0b3546a61`:
`model-file.deregister.service` and `storage-resolver.deregisterByFile`. They arrived in #3959's
merge base rather than from here, they were blocking that PR, and sky took those two files only —
deliberately not the branch, because pulling 134 files of unreviewed slice work into a PR reviewed at
a different scope would be a different PR wearing a reviewed one's clothes. **So expect those two to
appear on both sides; that is intentional, not a double-apply.**

### 🔴 `storage-resolver.deregisterByFile` is a RECORDED REFUSAL, not an unfinished job

It is converted for `~/server/logging/client` and **stops there on purpose**. Its `~/env/server`
mock stays because **the tests MUTATE `envValues` per case** — lifting it would leave the local alive
and disconnected, and every later assignment would write to an object nothing reads. That is the
class where converting further is the mistake and **no run can see the difference either way**: when
this was first found, four of six such files were mutation-affected and the run caught two; the other
two went green while silently exercising the opposite branch.

`~/env/server` is a **pending** specifier, so this does not hold the canonical gate. Anyone reading
the allowlist later will see the file listed for env.

🔑 **Sharpened after sky checked the one link I could not swear to — the claim is narrower and
stronger than "must stay".** The canonical `env` proxy **does** honour post-hoc assignment:
`env.mock.ts:79` writes `env.FOO = 'x'` straight into `overrides`, and `read()` at `:45` checks
`overrides.has(prop)` first, with `defineProperty` and `deleteProperty` traps landing in the same
map. (Verified here by reading it, not taken on report.)

That does **not** rescue a lift — the proxy honours assignment *to `env`*, and it cannot honour
assignment to a different object that used to be the mock, which is exactly what a lift leaves
`envValues` as. **But it does mean the file is convertible by REWRITE**: move the mutations into
`setEnv({…})` or a direct `env.X = …` inside the case that needs them, and the not-configured branch
stays reachable.

**So: this file must not be LIFTED. Converting it properly is a rewrite, and the rewrite needs its
own probe** — one that makes the not-configured case FAIL after conversion. That was out of scope
for a two-file unblocking task, and *a refusal to do it the cheap way is not a claim that it cannot
be done*. Do not record this as permanently refused; nobody has earned that.

The logging half is the *fix* for that family rather than a risk to it, and it was verified rather
than argued: pointing `logToAxiom` at an unrelated `vi.fn()` reds **7 of 13**, which proves the
module calls the canonical node instead of a spy bound by per-file re-instantiation. **The file was
green before the conversion and green after, and neither green was informative — the mutation is the
entire result.**

🔑 **A reviewer added the mechanism that makes this stronger than a compromise.** The shielding
hazard cannot re-enter here at all, because `logToAxiom` is a canonical hybrid node whose identity is
cached in a module-level `Map` for the life of the worker (`hybrid.ts:30`, `:48-95`). **The binding
is correct whether or not the consuming module re-instantiates**, which is precisely what a per-file
spy could not promise. So converting logging while keeping env is not half a job — it is the right
split, and the canonical mock **removes** the hazard rather than dodging it.

⚠️ **One claim of mine in this section is reasoned, not independently confirmed**, and the reviewer
was right to label it: that a per-file `~/env/server` mock *forces* the consuming module to
re-instantiate under `isolate: false`. It is the standard account of how the `deregisterBatch` /
`deregister` failure worked, and nothing here depends on it — the `Map`-cached identity above makes
the binding correct either way. Recorded as reasoned so nobody quotes it as measured.

### What is NOT established

**Nothing in this slice has been adversarially reviewed.** Every verification in this document is the
author's own, of the author's own work. It should not merge onward to `main` on that basis, and #3973
says so in its own body.

### The two that remain, and what unblocks them

`model-version.blue-buzz-purchase` and `model-version.purge-by-hash`. Both reach `getDbWithoutLag`,
and `REPLICATION_LAG_DELAY` is a zod `.default(0)` key **absent from `TEST_ENV_DEFAULTS`**, so the
canonical env reads `undefined` and `undefined <= 0` is `false` where `0 <= 0` is `true`. Checked
against the base on 2026-08-15, not inherited: `TEST_ENV_DEFAULTS` is still hand-enumerated, so the
seeding fix has not landed. **When it does, these two become ordinary entry-point conversions.**

### ⚠️ #3973 is a STACKED PR — the retarget after #3959 lands is load-bearing

Its base is `perf/test-mock-system`, which is #3959's head. `CLAUDE.md` forbids this shape for a
reason with an incident behind it: **a squash-merged parent does not retarget the child**, so the
child ends up pointing at an orphaned branch and its changes go missing (PR #2520, June 2026).

The plan already dissolves it — after #3959 merges, #3973 rebases onto the new `main` and goes to
`main` directly with its own review. **But the retarget is silent if forgotten.** Concretely:

1. #3959 → `main`.
2. **Retarget #3973's base to `main` AND rebase** — not one or the other.
3. **Confirm the diff is still 132 files against the new base** before anything else. If it is not,
   stop: something merged twice or went missing.

It was deliberately NOT merged into `perf/test-mock-system` first, because that would have grown
#3959's unreviewed diff to `main` by 132 files — folding a second large body of work into a PR that
was one review away from landing.
