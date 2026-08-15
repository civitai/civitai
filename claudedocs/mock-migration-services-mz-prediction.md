# Services `__tests__` m–z — conversion prediction, recorded before the codemod ran

Slice: `src/server/services/__tests__/`, the 40 allowlist files sorting from
`model.service.vae-append-no-mutation.test.ts` to the end. Base `5ee56c6658`.

This file is written **before** `codemod-shared-mocks.mjs --dry` was run against the slice, so
that a large miss is legible as a classifier bug rather than absorbed silently. The classifier
is `scratchpad/classify.mjs`, written from `docs/testing/shared-module-mock-migration.md` and the
canonical defaults in `src/__tests__/mocks/{db,redis,logging}.mock.ts`, without reading the
codemod source.

## Prediction

**5 of 40 auto-convertible.** Second estimate, **8 of 40**, if josh's report that the codemod
converts drifted `REDIS_KEYS` literals instead of refusing them is right (see below).

| bucket | n | mechanism |
|---|---|---|
| convert | 5 | factory leaves are bare `vi.fn()`, passthrough wrappers, or restatements of a canonical default |
| behaviour | 20 | a leaf carries real behaviour the canonical default does not cover |
| alias | 7 | one local serves both `dbRead` and `dbWrite` |
| extraExport | 7 | factory declares an export the canonical mock does not own |
| importOriginal | 1 | `importOriginal` spread whose override carries behaviour |

Predicted convert set:

```
placement-metrics.service.test.ts
placement.service.test.ts
redeemableCode.service.test.ts
strike.service.test.ts
tag-with-model-count-cache.test.ts
```

## Stopping rule

If the codemod's actual auto-convertible count falls outside **3–10**, stop and diff the two
classifications file by file before converting anything. A miss in either direction is a
classifier bug or a codemod behaviour the recipe does not describe, and neither is visible in a
green run.

## The one place I expect to be wrong, and why I did not adjust for it

josh (services a–l) reports from his own dry run that the codemod **converts** files carrying
`REDIS_KEYS` literals that have drifted from the real table, silently swapping the real constant
in — where the recipe says it refuses on divergence. My classifier follows the recipe and refuses
these three:

```
paid-access.service.test.ts            PAID_ACCESS = 'test:paid-access'
scanner-policies.buffer.test.ts        RUN_CANCEL  = 'scanner-policy:run-cancel'
nowpayments.currencies.memoize.test.ts SUPPORTED_CRYPTO_CURRENCIES = 'packed:caches:supported-crypto'
```

None of the three values appear in `packages/civitai-redis/src/client.ts`. `'test:paid-access'`
is a self-evident placeholder; the other two are plausible enough to survive a reading, which is
the class the recipe warns produces invisible drift.

I have left the primary prediction unadjusted so the codemod result discriminates between the
recipe and josh's observation rather than confirming a number I already moved. Whichever way it
lands, the three drifted constants get logged whether or not the suite goes red — a drifted
constant nothing asserts on can neither fail nor be reviewed.

## Outcome — the stopping rule fired

```
codemod --dry, 40 candidate files: 11 convertible | 30 with refusals
  fully converted (every canonical specifier):  10
  partial (converted one, refused another):      1   <- counts as NOT migrated
  fully refused:                                29
predicted convert: 5        stopping range: 3-10        actual: 11
PER-FILE AGREEMENT: 27/40 (68%)  — 9 I called refuse converted, 4 I called convert refused
```

Both the net and the per-file rule fire. The two error populations partly cancel, which is the
shape sky flagged from josh's slice: a net closer to 5 would have licensed a classifier wrong in
both directions at a 33% rate. Two distinct bugs in mine, both found by diffing per file:

**Bug 1 — ES6 shorthand properties are invisible to it (4 false converts).** `dbRead: { keyValue:
{ findUnique }, $queryRaw: queryRaw }` has one leaf my `key:` regex can see. The codemod refuses
the shorthand as a `non-literal property inside a model object`; I saw an empty model and passed
it. `placement.service`, `placement-metrics.service`, `redeemableCode.service`, `strike.service`.

**Bug 2 — it scans into nested literals that are not the client (contributed to the 9 false
refusals).** In `search-error-log-pii` the redis factory builds a permissive key stand-in,
`new Proxy(() => 'k', { get: () => make() })`, and I read that handler's `get` as a client method
carrying behaviour. The client itself is `{ packed: { get: vi.fn(), set: vi.fn() } }` and converts
cleanly. The codemod was right and I was wrong.

## Two claims that did not survive contact

**Drifted `REDIS_KEYS` constants are converted, not refused.** josh reported this from a–l and it
reproduces here: `nowpayments.currencies.memoize.test.ts` converted while the report named
`REDIS_KEYS.CACHES.SUPPORTED_CRYPTO_CURRENCIES` as real
`"packed:caches:supported-crypto-currencies"` vs test `"packed:caches:supported-crypto"`. The
recipe said it refuses on divergence; that sentence is now corrected in
`docs/testing/shared-module-mock-migration.md`. One drifted constant in this slice, logged here
because a drifted constant nothing asserts on can neither fail nor be reviewed.

**`importOriginal` shapes are not uniformly refused.** `vae-files-cross-version.test.ts` mocks
`~/server/redis/client` through `importOriginal` and the codemod converted it. Worth knowing
before treating "it is an importOriginal, so it is hand work" as a triage rule.

## One conversion to watch in the control

`search-error-log-pii.test.ts` replaces a permissive `REDIS_KEYS`/`REDIS_SYS_KEYS` proxy — every
path resolves to a callable returning `'k'` — with the real key tables. Any key path the test
walks that does not exist for real goes from `'k'` to `undefined`. That is the intended direction,
but it is a behavioural change the collected-count diff cannot see, so it needs reading at
assertion level rather than colour.

## `blocks/` — what `app-block-ids` actually clears, and whether order is worth sequencing

Bar: a file is fast-eligible when its ENTIRE mocked-specifier set is canonical. Denominator is the
**98** files under `src/server/services/blocks/` that mock at least one module; the other 39 mock
nothing and were never the problem. Base with the canonical three alone: **17**.

**`~/server/utils/app-block-ids` is mocked by 24 files and clears 8 of them.** The other 16 still
carry something else:

```
after app-block-ids lands, remaining non-canonical specifiers per file
  0 left:  8 files   <- the unlock
  1 left:  7 files
  2 left:  2 files
  3 left:  3 files
  5+ left: 4 files
```

**24 is a frequency, not an unlock, and the two are not the same ranking.** The most-mocked
specifier in the directory is `~/env/server` at 25 files, and it clears 6 — fewer than the
second-most-mocked. Anyone ordering by "how many files mock it" starts on the wrong one.

Cumulative fast-eligible files as specifiers are made canonical, three orders:

```
k       greedy   by-frequency   alphabetical
1           25             23             17
3           36             34             19
5           42             36             20
8           48             42             22
15          60             62             32
20          65             68             34
40          88             85             49
59          98             98             98
```

**Sequencing is worth doing and optimising it is not.** Any unlock-aware order beats an arbitrary
one by a wide margin — at k=8, 48 files against 22. But greedy versus by-frequency is a wash: it
leads by at most 6 files around k=5 and by-frequency is *ahead* at k=15–20. So take
`app-block-ids` first because it is the best single step, then stop modelling and work the list;
the difference between a good order and the best order is noise next to the difference between a
good order and no order.

## `orchestrator/` and `generation/` are the opposite shape, and the ratio says so before any work

Same measurement over the other two subdirectories. Distance = non-canonical specifiers a file
still needs before its entire mock set is canonical.

```
                files  union of      distance-to-eligible
                w/mock  specifiers   0    1    2    3   4+   heaviest file
blocks/            98      59       17   31   22    9  19        8
orchestrator/      18      33        0    3    2    3  10       13
generation/         7      17        0    0    1    0   6       15
```

**Read the files-to-specifiers ratio.** `blocks/` is 98 files over 59 specifiers and half of it sits
within one specifier of eligible — work it incrementally, as agreed. `generation/` is 7 files over
17 specifiers with six of the seven needing 13–15 each: no single specifier completes any file, and
a greedy sequence plateaus at zero. That is the clique shape, and incremental burn-down of it will
read as zero progress for its entire length no matter which order it is worked.

**But a clique is not automatically a big job — check the union before treating it as one.** The
whole of `generation/` is 17 specifiers for 7 files. That is a bounded cohort someone can clear in
one pass, and the only wrong move is to schedule it as if it were a burn-down. `orchestrator/` is
bimodal rather than uniform: 5 files within two specifiers, then a cliff to a 9-file
`orchestration-new.*` family needing 8–13 each. Take the 5, then treat the family as its own
cohort.

## The two classifier bugs, fixed and re-measured

Both are logged here rather than only in mail, because a predictor that quietly keeps them will
mislead the next slice.

- **ES6 shorthand read as an empty object.** `{ keyValue: { findUnique } }` has no `key:` token, so
  a regex scan sees a model with no leaves and passes it. The codemod refuses it as a `non-literal
  property inside a model object`. Fix: walk the object literal properly instead of regex-scanning.
- **Regex scanning descends into literals that are not the client.** In `search-error-log-pii` the
  redis factory builds `new Proxy(() => 'k', { get: () => make() })` as a permissive key stand-in;
  the handler's `get` reads exactly like a client method carrying behaviour. Fix: only descend
  through property values of the returned object.

Re-measured on the same 40 files: per-file agreement **27/40 -> 30/40**, false converts 4 -> 2.
Eight false refusals remain, so the predictor still errs conservative.

**Two deliberate choices about it, recorded because the reasoning outlives the artifact.**

*The conservative bias is kept, not fixed.* An error pointing this way flags a file for a human to
read that the codemod would have converted silently. The opposite error ships a silent conversion.
One costs a read; the other costs a regression nothing observes.

*It is not checked into `scripts/` beside the codemod.* At 75% per-file agreement it is a control —
something to disagree with the codemod so a human looks — and a tool that sits in the tools
directory gets used as an authority. Its whole value is being wrong in a legible direction, which
is a property nobody would infer from finding it next to `codemod-shared-mocks.mjs`. It stays in the
scratchpad; what is durable is this description of what it got wrong and why.

## Slice boundary

josh took the flat allowlist files under `src/server/services/__tests__/` through
`model-version.purge-by-hash.service.test.ts` inclusive (129). My 40 is the tail after it, and
**includes** the three files whose leading `m` puts them with him under a letter rule but which
sort after the named endpoint (`-` 45 < `.` 46 < `3` 51):

```
model.service.vae-append-no-mutation.test.ts
model3d-visible-id-for-post.test.ts
model3d-visible-ids-batch.test.ts
```

129 + 40 = 169 = the flat total. No overlap, no hole.

## Slice size — the brief's count is high

The brief put this slice at "roughly 84 files". On disk the m–z range holds 61 `.test.ts` files;
40 of them carry a direct mock of a canonical specifier and appear in the allowlist. 84 matches
neither. The burn-down is the allowlist, so the work is 40.

---

# What actually shipped, and the four things the runs taught that the prediction could not

Written after two tenancies. The sections above are the record as it stood before either.

## State

```
allowlist 345 -> 334 across this slice   11 files migrated
converted and verified:   9   (one of which shipped PARTIAL and was fixed - below)
converted, unverified:    2   (the alias batch; its pair is pending)
refused deliberately:     2   nsfwLevels.buffer-flag (partial), placement-escrow (runtime write)
blocked on someone else:  1   sticker-placement, on the spendType fixture
```

## 1. A partial can ship with the codemod reporting zero refusals

`nowpayments.currencies.memoize.test.ts` converted for redis with an empty `refusals` array while a
direct `vi.mock('~/server/logging/client', …)` sat three lines above. Neither the codemod nor the
allowlist generator counted it, so it shipped converted-for-one-axis and still poisoning its worker
for the other.

**Do not read the codemod's silence as coverage.** An empty refusals list means "nothing I could see
stopped me", and before `92f1728652` it could not see every canonical mock in a file.

**And run `residual-mocks.mjs` per file against your converted list, never as a set total.** The total
cannot distinguish "these sites belong to hold-outs" from "a file I converted is still mocking". I ran
the right command and read the wrong number.

## 2. Drift: the noise belongs to the isolation mode, not the box

Twelve runs in one uncontested tenancy — four on the pre-conversion tree, four on the shipped tree,
four repeating the shipped tree with **not one byte changed**. The last pair is the drift measurement.

```
config       collect s        setup s      test s          wall s
iso-4        207.0 -> 190.2    7.9 -> 7.8   6.3 -> 6.8     61.3 -> 59.5   -2.9%
iso-8        246.2 -> 221.3   10.8 -> 8.8   7.6 -> 7.5     41.6 -> 35.7  -14.2%
noiso-4       82.9 ->  51.7    9.2 -> 9.3   9.8 -> 6.9     26.4 -> 18.0  -31.8%
noiso-8      122.6 -> 120.8   10.0 ->10.8  168.8 -> 3.5   180.8 -> 17.9  -90.1%
```

**For a 40-file set of 18-61s, wall drift with nothing changed was 2.9-14.2% isolated and 31.8-90.1%
under `--no-isolate`** — and that bound is for 40 files, not for a 1,069-file suite where fixed startup
is a far smaller fraction and there is more opportunity to collide. It is a floor on how much variance
exists, not an error bar to staple onto other people's numbers.

`collect` is the noisy phase, which is the phase this project's headline numbers are quoted in. A
wall-only spread hides that.

**The -90.1% is one file** — `stripe.manageInvoicePaid.attribution` at 165.4s then 0.0s back to back.
Not a conversion artifact: across all eight `--no-isolate` runs that file swings 0-9 failures *before*
conversion too. One stall in twelve runs, reported rather than explained.

**And the number that matters more than the drift table:** the same pre-conversion tree at the same
width gave **49 failures in one tenancy and 122 in another**, both uncontested. Within a tenancy it
was tight (108 vs 106). So a `--no-isolate` failure count is reproducible within a tenancy and not
across one. Per-file collected counts were identical throughout, which is the only reason any of these
pairs are readable.

## 3. The conversion does not introduce the bug, it removes the accident hiding one

`paid-access.service.test.ts` invented `'test:cap-tier'`; the real key is
`packed:caches:paid-access-cap-tier`. Swapping it in turned **one** assertion red — and left **five**
uses of the same literal silently taking the else branch of `key === 'test:cap-tier' ? tiers : gates`,
passing while feeding the wrong fixture, one of them vacuously (`toHaveLength(0)` against a filter that
can no longer match). One test failed; five stopped testing what they name.

Neither collected counts nor `residual-mocks.mjs` can see the five. **When a conversion swaps a
constant, grep the whole file for the old literal** rather than fixing the assertion that failed.

## 4. Which client an aliased call belongs to is a fact in the production code

The recipe's "split them and expect red" is a way of finding out by breaking things. Read it instead:
take every `<local>.<table>.<method>` the test drives, grep `src/server` for `dbRead.<path>` and
`dbWrite.<path>`, and resolve each to `dbRead`, `dbWrite`, or **`BOTH - read the call site`**.

`toggleBookmarked` reaches for `dbWrite` on every path **including its reads**, which no method name
would tell you. Both files in the alias batch bind entirely to `dbMock.dbWrite`, so the prediction is
that neither goes red — and a red means the mapping is wrong rather than the test being interesting.

⚠️ **If a db-axis conversion reds in a way the mapping does not explain, look for a second direct mock
in the same file before doubting the mapping.** A file partial across two axes goes red when you fix
the axis you were working on, and the fix is the other axis's canonical mock — never restoring the
shielding mock. Doubting the mapping first sends you to re-read production code that was right.

## Two inference mistakes I made, both the same shape

**"The gate moved while my change was in the tree" is not "my change moved the gate."** I reverted
`sticker-placement`'s conversion because the tests gate went 16 -> 17 and I could not attribute the
extra error. The pre-conversion state was one `git checkout` away and I never ran the gate against it;
another agent later measured 17 on the base with the file unconverted. The rule that a file whose gate
count moves without an attributable line does not ship is right. Checking whether it moved *because of
you* is the step before it, and it is free.

**A negative from the wrong test is worse than no test, because it closes the question.** I proposed
that tonight's `Placement.spendType` column caused that +1, then killed the idea because `db:generate`
dirtied nothing tracked in my worktree. That only rules out my own regen — the generated client can
move by someone else's commit on the base, and it did.

Both are the same shape as reading two coincident timestamps as cause and effect.
