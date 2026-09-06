# Image resource hash matching: why locally-generated uploads miss their LoRAs

ClickUp 868ktap9r.

A creator reported that images generated locally (Forge / Forge Neo) fail to auto-detect LoRA,
LyCORIS and LoCon resources on upload, while on-site generations attribute correctly — leaving them
to attach every resource by hand on every image.

This document records what the failure actually is, the evidence, and a proposed fix. Measurements
were taken against the production read replica on 2026-08-18. Where two independent review passes
produced slightly different counts, the later figure is used and the drift noted.

> The `src/utils/metadata/*.metadata.ts` parsers cited by `file:line` below were since replaced by
> `@civitai/generation-metadata` (behavior-preserving; parity-gated over its fixture corpus). The
> references describe the pre-migration code; the equivalent logic now lives in that package.

---

## How matching works today

Detection runs in `packages/civitai-db-schema/prisma/programmability/get_image_resources.sql` as a
four-stage pipeline.

**Stage 1 — collect candidates** (lines 70–154). Five `UNION ALL` branches pull `(name, hash)` pairs
out of `Image.meta`, because different tools write metadata differently:

| Branch | Source | Shape |
|---|---|---|
| 1 | `meta.resources[]` | array with name / hash / weight |
| 2 | `meta.hashes{}` | object — **the Forge / A1111 path, and the subject of this document** |
| 3 | `meta."Model hash"` | single checkpoint string |
| 4 | `meta.civitaiResources[]` | carries `modelVersionId` **directly — no hash** |
| 5 | `Post.modelVersionId` | inherited, `detected: false` |

Branch 4 is why on-site generations always work: we wrote that metadata ourselves and put the
version id in it, so no matching is required.

Branches 1 and 2 both carry the affected values — `automatic.metadata.ts:259-268` builds a
`resources[]` array from the same `Lora hashes` field that populates `hashes{}`. Both hold the
identical hash string, so both fail identically; there is no rescue path between them.

**Stage 2 — resolve** (line 167). The join itself is one exact string equality, case-insensitive
via `citext`, **with no HASH-type filter** — see the note below on the role and file-type filters
that were since added beside it, which constrain what may match but not which algorithm:

```sql
LEFT JOIN "ModelFileHash" mfh ON mfh.hash = irh.hash::citext
```

**Stages 3–4 — dedup and filter** (lines 181–211). Two `row_number` windows pick one winner per
hash and one per version, preferring `detected` → has-strength → published → oldest version →
lowest `fileId`. Versions carrying `excludeFromAutoDetection` are dropped, and the
`lora:` / `embed:` / `hypernet:` name prefixes are stripped.

### Since superseded in part: matching values is now constrained by ROLE and FILE TYPE

ClickUp 868m16ckn (FD 69881) found the mirror-image of this document's bug. Matching values rather
than identities does not only MISS resources — it also matches the WRONG one. A component file that
many creators bundle beside their checkpoint (an upstream text encoder, a VAE) resolves to every
version hosting it, and the Stage 3 tie-break awards the image to the earliest published: a
stranger's model, credited on a page the uploader cannot correct. One Qwen3-VL text encoder did that
to 51 images across 7 creators; 12,812 AutoV3 hashes sit on files owned by more than one user.

Two filters now sit in `image_resource_merge` (and in the TypeScript mirror): the role the metadata
declares must be one a Civitai model version can be, and the matched file must not be of a type that
can never be the resource. They constrain WHAT may match, not which algorithm produced the value, so
everything this document says about hash widths still holds. Full rationale and the production
measurements are in the header of `get_image_resources.sql`.

### The design property that causes the bug

Because Stage 2 applies no type filter, that single join matches **all six** stored hash types at
once. A tool writes 10 characters and hits `AutoV2`; 12 characters and hits `AutoV3`; 64 and hits
`SHA256`. It resolves without needing to know which algorithm produced the value.

That is genuinely useful, and it is also the defect: **the system matches _values_, not
_algorithms_.** It behaves as a lookup table of every hash string we have ever stored, and detection
succeeds if and only if the generating tool wrote a string we hold verbatim. Exact equality cannot
see that one string is a *prefix* of another.

---

## Root cause

Two different algorithms both produce a 12-character value, and we stored only one of them.

- `AutoV3` (12 chars) is a tensor-only / addnet-style hash. Most A1111 and Forge builds write this,
  and it matches. It is the **only** 12-character type we store.
- Some Forge builds instead produce
  **`SHA256` truncated to 12**. We store `SHA256` only at its full 64 characters, and `AutoV2` is
  `SHA256` truncated to **10**.

So a `SHA256[0:12]` value matches nothing: too long for `AutoV2`, too short for `SHA256`, and the
wrong algorithm for `AutoV3`.

### The SwarmUI parser is NOT part of this population — do not "fix" it

An earlier revision of this document claimed `src/utils/metadata/swarmui.metadata.ts:92` manufactures
the broken value class, and recommended changing `.slice(0, 12)` to `.slice(0, 10)`. **That was
wrong, and making the change would break SwarmUI detection.** Recorded here so it is not proposed
again.

```ts
hash: hash?.replace('0x', '').slice(0, 12),   // correct as written — leave it alone
```

SwarmUI's `sui_models[].hash` is a **tensorhash**, not a file SHA256 — per its own spec, linked at
`swarmui.metadata.ts:21`: *"a hash of the data of the model processing only its tensor sections and
not its header (ie to allow metadata to change without affecting the hash)"*. That is the same
quantity as `AutoV3`, which we store truncated to 12. (Prod did that in a `truncate_autov3_hash()`
trigger, `SUBSTRING(NEW.hash FROM 1 FOR 12)`; `normalizeScanHashes()` took it over in application
code and migration `20260819010000` drops the trigger.)

So `.slice(0, 12)` lands **exactly on `AutoV3`** — the one 12-character value that does match.
Truncating to 10 would produce a 10-character *tensor*-hash prefix, and `AutoV2` is a *file*-hash
prefix, so it would match nothing.

This also explains the AutoV3 collision behaviour noted under Collision analysis: 1,505 AutoV3 values
shared by byte-different files is exactly the "allow metadata to change without affecting the hash"
property, working as designed.

No parser rewrites hash lengths in a way that creates the broken class: `automatic.metadata.ts`,
`comfy.metadata.ts` and `base.metadata.ts` pass values through unchanged, and the one truncation that
exists (SwarmUI) targets a different algorithm correctly. **The `SHA256[0:12]` population is written
by Forge upstream, not by us.**

### Worked example

A failing upload carried:

```
"model": "5585a4a38c"                            → equals an AutoV2   ✓ checkpoint detected
"lora:<name>": "ffdb3743c1c8"                    → equals nothing     ✗
```

For that LoRA (model version 3214341) we hold all three of:

```
AutoV2   FFDB3743C1                  ← incoming is 2 chars LONGER
AutoV3   A3F3524A10A9                ← same length, DIFFERENT algorithm
SHA256   FFDB3743C1C8…(64 chars)     ← incoming is 52 chars SHORTER
incoming ffdb3743c1c8
```

Three near-misses, zero equalities. We have the right file; we simply never stored that particular
truncation of it. The checkpoint on the same image resolved normally, which is exactly the reported
split. Independently reproduced end-to-end through the live `get_image_resources()` on image
138775138, where a 12-char LoRA hash returns NULL while a 10-char checkpoint hash on the same image
resolves.

---

## Evidence

### The originally-proposed explanation was close but not correct

The intake hypothesis was "Forge writes 12 characters, we store AutoV2 at 10." The mechanism is
right — a length mismatch defeating exact equality — but the conclusion that we hold no
12-character hash is wrong. We do (`AutoV3`), and it carries the large majority of matches.

The supporting test ("truncate the sampled LoRA hash to 10 and look it up — nothing found") was run
against a sample from an unpublished, local-only LoRA, so it could not have resolved regardless of
the hypothesis.

### `AutoV3` is genuinely a different algorithm

Verified across the 1,341,015 files carrying all six types: `AutoV3` is not `left(SHA256,12)`, not
`left(BLAKE3,12)`, does not have `AutoV2` as its own prefix, and is not `CRC32||AutoV1`. It is not
derivable from anything else we store — so no rewrite of the incoming value can reach it.

### The model-creation-date boundary is a confound

The report identified a boundary where versions from 2024 work and versions from 2025-07-21 onward
fail. Model-side data is **identical** across all seven cited versions — same hash set
(`AutoV1, AutoV2, AutoV3, BLAKE3, CRC32, SHA256`), exactly one `Model`-type `ModelFile` each, all
`Published` and `Public`, `scannedAt` non-null, none carrying `excludeFromAutoDetection`. The only
difference found was `baseModel`, which no join reads.

The decisive test: model-version age of the matching vs failing cohorts is statistically
indistinguishable.

```
exact-match cohort   n=2549   p25 2025-03-02   median 2025-10-07   p75 2026-06-28
sha256[0:12] cohort  n=168    p25 2025-02-21   median 2026-01-07   p75 2026-07-05
```

**There is no model-date boundary.** The real signal is the generating tool, grouping one day's
entries by `meta.Version`:

```
f2.0.1v1.10.1-…-gdfdcbab6   n=3143   exact=2140   sha12=784
neo-2.26                    n=2786   exact=2157   sha12=559
neo-2.23                    n=519    exact=309    sha12=210
v1.10.1 (stock A1111)       n=2409   exact=2341   sha12=5
```

Stock A1111 is clean; Forge and Forge Neo carry essentially all of it. **It is not purely per-build,
though**: 1,332 images in that single day contain *both* an exact-matching and a `sha12` LoRA hash,
so the same build emits both forms depending on the file. Treat "which build" as an open question,
not a settled one.

### Impact, measured

Two independent samples over different windows:

| Outcome | Sample A (1 day, n=800) | Sample B (1 day, n=2887) |
|---|---|---|
| Matches `AutoV3` — works today | 680 (85%) | 2549 (88.3%) |
| Recoverable via `left(,10)` + SHA256 confirm | 57 (7.1%) | 168 (5.8%) |
| Matches neither — genuinely local / unpublished | 63 (7.9%) | 170 (5.9%) |

So the fix recovers roughly **6–7% of all LoRA references, and about half of currently-failing
ones**. In sample B, **all 168** prefix hits also passed the 12-character SHA256 confirmation —
zero false 10-character prefix hits.

---

## Collision analysis

Any fix matching on a 10-character prefix inherits `AutoV2`'s collision profile, so it was measured
rather than assumed.

10 hex characters is 40 bits. With **1,425,823** distinct model files, expected colliding pairs
≈ n²/2N = **0.92**. Observed: **1**. The estimate is accurate, so it projects:

| Distinct files | Expected 10-char collisions | Expected 12-char collisions |
|---|---|---|
| 1.43M (today) | 0.9 (1 observed) | 0.004 (0 observed) |
| 3M | 4 | 0.02 |
| 10M | 46 | 0.18 |
| 20M | 182 | 0.71 |

Collisions grow quadratically, so 10-character matching degrades faster than the catalog grows.

**`AutoV2` multi-file values (45,751) are duplicate uploads of byte-identical files** — the existing
`row_number` dedup already resolves those, and only **1** is a true prefix collision.

**`AutoV3` is different, and worse than a naive reading suggests.** 44,321 `AutoV3` values map to
more than one file, and **1,505 of those map to byte-*different* files** — roughly 400,000× what
48-bit birthday collisions would predict. That is not probabilistic: `AutoV3` is a tensor-only hash
that is deliberately blind to header/metadata differences, so two files with identical tensors and
different metadata share one. This argues *for* the SHA256-confirm path below, which has 0
collisions against `AutoV3`'s 1,505.

This 10-character exposure is **pre-existing, not introduced by this work**: `AutoV2` is already the
primary key for checkpoint matching and for 43,568 LoRA references in 14 days.

---

## The fix

Store the missing width. `SHA256_12` is a new `ModelHashType` holding `SHA256` truncated to 12
characters — the exact value A1111/Forge writes — so the **existing** exact-match join resolves it
like any other hash type.

**`get_image_resources.sql` is not modified.** Its Stage-2 join has no `type` filter, so a new row
of any type is matched by the SQL already in production. Verified on a 73-image corpus: simulating
the post-backfill rows against the unmodified function passes all 12 assertions.

This is not a special case bolted onto the resolver — it is the same mechanism `AutoV2`
(`SHA256[0:10]`) and `AutoV3` (tensor hash at 12) already use. The schema is a table of truncations
mirroring what generation tools emit; this fills the one entry that was missing.

| Change | Where |
|---|---|
| `SHA256_12` enum value | `schema.full.prisma`, migration `20260819000000_model_file_hash_sha256_12` |
| Derive it | `normalizeScanHashes()` in `src/server/services/model-file-scan.service.ts`. Produces every truncated form (AutoV3, SHA256_12) in one place, in application code. Both hash-writing paths call it — `applyScanOutcome` and `/api/mod/reprocess-scan`, which needs it independently because it replays `rawScanResult` where AutoV3 is still full-length. |
| Guard it | `src/server/services/__tests__/model-file-hash-writers.test.ts` — a ledger of every `ModelFileHash` writer, enumerated from source, failing when the set grows or shrinks; plus behavioural cases in `reprocess-scan-hash-derivation.test.ts` and `model-file-hash-writer-exemption.test.ts` |
| Backfill existing files | 🔴 **not implemented** — see below |
| Detection SQL | **unchanged** |
| Public API | **unchanged** — the new type is returned alongside the others, exactly as `AutoV2` (also a `SHA256` truncation) already is |

### Why not a prefix match in SQL

Earlier drafts matched `left(SHA256,12)` in the resolver, either via a functional index or via an
`AutoV2` prefilter plus a confirmation join. Both work, and the index version is only ~50 MB against
~400 MB of rows. They were rejected because each adds a code path to a function this investigation
broke three separate ways — a `citext` comparison that silently never fired, a `LATERAL` that fanned
out unconfirmed candidates, and a row-order perturbation that displaced which unmatched resource the
uploader is warned about. Adding rows introduces no new code path, so none of those modes exist.

Storage is net negative anyway: +400 MB of rows against −577 MB from dropping `modelfilehash_hash`,
an index on `lower(hash)` over a `citext` column with **849 lifetime scans**.

### Backfill — 🔴 NOT IMPLEMENTED

This section previously documented a `GET /api/admin/temp/backfill-sha256-12` endpoint, and the
`20260819000000` migration told the operator to run it. **That file has never existed on any
branch** (`git log --diff-filter=A -- src/pages/api/admin/temp/backfill-sha256-12.ts` returns
nothing), so following either instruction gets a 404.

The design it described is still the right one — derive entirely from stored `SHA256` rows, no file
access, no orchestrator, no re-scan; batch internally, log a resumable cursor, idempotent via
`ON CONFLICT ("fileId", type) DO NOTHING` — it just has not been written.

Until it is, the split is: files scanned **after** the release that ships `normalizeScanHashes()`
get their `SHA256_12` row from the scan path; files scanned **before** it keep failing 12-char LoRA
detection exactly as they do today, indefinitely. That is not a half-broken state, but it is also
not self-healing — the existing corpus needs either this backfill or a replay through
`/api/mod/reprocess-scan`.

### One accepted behaviour change

A hash that resolves only to a `Deleted`/`Unpublished`/`UnpublishedViolation` model now has its row
dropped by the merge `WHERE`, the same as an exact match on such a model already does. Today those
hashes match nothing and survive as unmatched, so the uploader sees a warning; afterwards they are
removed silently. Measured at 8 corpus images and roughly 32 of 297 fallback-eligible hashes per two
days.

Preserving the warning was tried and cost three extra joins in the resolver. The property that
matters is asserted instead: such a hash is **never attributed** to a bad-status model. Restoring
the warning is a follow-up against the pre-existing behaviour, not part of this change.

---

## Alternatives considered

**Emit `left(hash,10)` as an extra Stage-1 candidate row.** Materially simpler — no new joins, no
Stage-2 changes, and it works identically in both SQL files and the TypeScript mirror. When the
12-char value already matches `AutoV3`, both rows resolve to the same version and the existing
`(id, modelVersionId)` dedup collapses them.

The cost is 40-bit discrimination. That buys **1** avoided misattribution today against roughly
three extra joins across three implementations — so this is a genuine judgement call, not a clear
loss. The case for the confirm step rests on the **10M-file projection (46 collisions)**, not on
present-day benefit, and it should be argued on those terms.

**Store `SHA256[0:12]` as its own hash type row.** Because the Stage 2 join has no type filter, this
would work with *zero* SQL change — the most elegant option on paper. Rejected on size:
`ModelFileHash` is **8,751,379 rows / 2,305 MB** (744 MB heap + 1,561 MB indexes), and this adds one
row per `SHA256` row — **+1,486,996 rows, +17%, roughly 400 MB** — to store a prefix of a column
that already exists on a sibling row of the same table, plus a backfill over 1.5M files and a
scan-pipeline change.

---

## Where the changes land (superseded — see The fix)

**Two** implementations, not three:

1. `packages/civitai-db-schema/prisma/programmability/get_image_resources.sql:167` — read **and**
   write path
2. `src/server/services/generation/generation.service.ts:1542` — TypeScript mirror

⚠️ **`insert_image_resource.sql` is dead code. Do not change it.** Migration
`20250319210024_image_resource_new` dropped the function, nothing in `src/` calls it, and it is
confirmed **absent from production** (`pg_proc` lists only `get_image_resources`). It also still
targets the legacy `"ImageResource"` table rather than `"ImageResourceNew"`.

There is therefore no separate write path. `createImageResources()`
(`src/server/services/image.service.ts:8671`) is the live writer, and it consumes
`get_image_resources()` output — so fixing that one function fixes both directions.

🔴 **Latent hazard worth fixing separately:** `pnpm db:program` applies *every* `.sql` in the
programmability directory, so the next run **re-creates the dropped function**. It would be inert
(no callers), but it is a deliberately-removed object silently reappearing, pointed at the wrong
table. The file should be deleted rather than left to be resurrected.

⚠️ The TS mirror's `WHERE mfh.hash IN (${Prisma.join(uniqueHashes)})` works **only because** Prisma
sends untyped parameters that Postgres infers as `citext`. Any refactor adding `::text` to those
parameters silently breaks all detection. Worth a comment at that site.

Independently, `src/utils/metadata/swarmui.metadata.ts:92` should change `.slice(0, 12)` to
`.slice(0, 10)`.

This is a `programmability` change, and per `CLAUDE.md` migrations here are applied by hand — so it
needs a deliberate rollout rather than riding a deploy. Recovering the existing backlog additionally
requires re-running detection over affected images.

---

## Open / unresolved

**The 0x-prefix population is EXPLAINED and fixable, but deliberately not fixed.** These are
`sshs_model_hash` — the tensor hash sd-scripts writes into a LoRA's own safetensors header at
training time — truncated to 12 characters. A1111/Forge read it out of the file rather than
computing anything, which is why the value is identical across generators and constant per file.

Two formats exist, and only one survives truncation:

| `sshs_model_hash` in the file | tool writes | outcome |
|---|---|---|
| `6f9fdad2fc0a…` (64 hex, modern sd-scripts) | `6f9fdad2fc0a` | **already matches** — equals `AutoV3` on 2,954 of 2,966 sampled files |
| `0xe89653fcf2…` (`0x` + 64 hex, older sd-scripts) | `0xe89653fcf2` | **fails** — the `0x` occupies 2 of the 12 characters |

So it is the same quantity as `AutoV3`, written by an older toolchain with a prefix that survives
truncation. Old-format files are ~1.1% of a 3,000-file sample, matching the ~1.2% of LoRA
references that carry `0x`.

Note `sshs_model_hash` and `AutoV3` are NOT equal for old-format files (`0xe89653fcf2652a81…` vs
`7D4CEC3A2124` on file 3005864), so stripping the prefix and comparing against `left(AutoV3,10)`
resolves nothing — measured 0 of 60. Deriving from the stored header is the only route:

```sql
left("headerData"->>'sshs_model_hash', 12)   -- covers both formats in one rule
```

**Why it is parked:** measured 31 of 60 distinct `0x` values recoverable that way. The rest are
files whose header we do not hold or that lack the field (89% of *recent* Model files carry it;
older ones are thinner). That recovers roughly half of a ~1.2% population — on the order of 0.5%
of LoRA references — against the cost of another enum value, another backfill, and another type in
the public API. SHA256_12 recovered ~7% for the same machinery.

**The single-warning UI defect is in the SQL, not the component.** An earlier draft blamed
`AddedImage.tsx:625` filtering on `r.unmatched && r.name`, reasoning that `hashes`-only metadata has
no `meta.resources` array — which is false; `automatic.metadata.ts` builds one, carrying an explicit
`"unmatched": true` flag. The actual cause: `get_image_resources()` Stage 3 partitions
`row_number_version` on `(id, "modelVersionId")`, so **every unmatched row shares the `NULL`
partition and all but one is dropped**. The `OR iri.hash IS NULL` escape in Stage 4 does not apply
because the hash is non-null. Confirmed on image 138775138, which carries two unmatched 12-char
LoRA hashes and returns one. Any "3 resources failed to match" UI needs this fixed first.

The path from SQL to screen is now fully traced: `createImageResources`
(`image.service.ts:8709`) builds its `unmatchedHashes` set from the rows the function returns, and
writes `unmatched: true` onto the matching `meta.resources` entries — which is what
`AddedImage.tsx` renders. One dropped row means one missing flag means one missing warning.

Measured across the 27-image corpus: **6 images under-report today**, e.g. 140048132 and 140050795
each have 3 unresolved resources but flag only 1. Under the fix that falls to 0 — though only
because the resources now resolve. **The NULL-partition defect itself is untouched**, and would
still cap the warning at one for any image with two genuinely-unmatchable resources.

**Stored `strength` is order-dependent on some images (pre-existing).** `get_image_resources` has no
`ORDER BY`, and `createImageResources` applies `uniqBy(modelversionid)`, which keeps whichever row
came first. Normally `row_number_version` guarantees one row per version — but the final
`OR iri.hash IS NULL` lets branch-4 (`civitaiResources`) rows bypass that filter, so an image
carrying *both* `civitaiResources` and `hashes` can emit two rows for one version. Measured on two
ComfyUI images in the corpus (140015836, 140015048): version 3181498 appears twice, once as
`('kreamania_variant6', hash 6a847a168a)` and once as `('checkpoint', hash NULL)`.

⚠️ **Correction:** an earlier revision claimed the two rows carry different `strength` values and
that the stored strength therefore flips. On review both rows carry `strength = 100`, so on these
two images `uniqBy` changes only `name`/`hash`. The duplicate emission and the `row_number_version`
bypass are measured; a differing stored `strength` is **not** — it remains a structural possibility
(the branches compute `strength` differently) rather than an observed one. Unchanged by this fix.

🔴 **The fix displaces which unmatched resource the user is warned about — fix the NULL partition
in the same change.** Found by differential testing over a 73-image corpus. Every NULL-version row
ties on all five `row_number_version` `ORDER BY` terms (`detected`, `strength IS NOT NULL`,
`version_published`, `version_date`, `file_id` are equal or NULL), so which one survives is
arbitrary. Adding the LATERAL perturbs row order enough to flip the winner: on image 139611295 the
unmatched row `2f735bfda14f` is present today and absent after, and on 139619240 a `0x` row is
displaced. Same-arm reruns are byte-stable, so this is **plan**-dependent, not run-dependent.

Attribution stays correct — nothing resolves that shouldn't, and the status guard holds. But the
single warning a user sees changes arbitrarily. Since the NULL-partition defect already caps that
warning at one, and this change reshuffles which one, the two should land together rather than in
sequence.

**Also unresolved:**

- Which Forge builds emit `SHA256[0:12]` versus the addnet hash. Aggregate `meta.Version` grouping
  pointed at Forge and Forge Neo, and file-level inspection then **ruled out a per-build
  explanation outright**: images 139444993 (fails) and 139830592 (works) were both written by
  `neo-2.28`, by the same creator. The same build emits both forms, so the determinant is something
  about the file — plausibly whether the LoRA carries safetensors metadata the addnet hash would
  skip. Unresolved, and a per-build fix would be wrong.
- `get_image_resources` excludes the empty-file hash `e3b0c44298fc` but `insert_image_resource` does
  not (70 rows match it exactly today). Pre-existing and unaffected by this fix, but the two
  functions should be reconciled.

---

## Deferred work item 1 — WITHDRAWN

This slot previously held a recommendation to change the SwarmUI parser truncation. It was refuted
on review and the reasoning is recorded under **The SwarmUI parser is NOT part of this population**
above. There is no parser-side change to make; the broken values originate upstream in Forge.

## Deferred work item 3 — the TypeScript mirror

**Not started. Must ship with, or after, the SQL — never before.**

`src/server/services/generation/generation.service.ts:1469` is **not** a port of the SQL join; it is
a different shape. It batches every candidate hash into one query and resolves in JS:

```sql
WHERE mfh.hash IN (${Prisma.join(uniqueHashes)})
```

There is no join to hang a `LATERAL` off. The prefilter-plus-confirm has to become a **second batch
round-trip**, run only for hashes the first pass left unresolved:

1. Take the unresolved candidates matching `^[0-9a-f]{12}$`, truncate each to 10.
2. Query `AutoV2 IN (…)` — one batch, using the existing `modelFileHash_hash_cs` index.
3. For the files that returns, fetch their `SHA256` siblings by `("fileId", type)` and keep only
   those whose first 12 characters equal the original candidate.
4. Feed survivors into the existing `bestByHash` preference ordering.

⚠️ **Steps 2–3 query `ModelFileHash` alone, so they must re-apply the guards the first query
carries** — the `m.status NOT IN ('Deleted','Unpublished','UnpublishedViolation')` filter and the
`excludeFromAutoDetection` computation. Omitting them lets excluded and unpublished versions through
the fallback, which is the TypeScript form of the row-deletion defect described above.

⚠️ **`bestByHash` is not actually a mirror of the SQL, and never was.** The TypeScript prefers the
**more recent** `versionDate`; `get_image_resources` orders `version_date` **ascending** (oldest
first). Pre-existing divergence, unrelated to this work — but anyone implementing "the same
preference ordering in both places" will get different answers, so decide which is correct before
copying either.

⚠️ **`Prisma.join` on a `citext` column is load-bearing here.** Those parameters resolve correctly
only because Prisma sends them untyped and Postgres infers `citext`. Any refactor that adds an
explicit `::text` silently turns every comparison case-sensitive and breaks **all** detection, not
just the new path. Worth a comment at that call site regardless of this work.

It needs its own fixtures. The `local/hashfix` harness exercises the SQL only.

## Verification fixtures

The images below are real uploads whose embedded metadata exercises each case. Fetch them from the
CDN at `original=true` (a transformed variant drops the metadata) to rebuild a fixture set.

| Image id | Case | Expected after a fix |
|---|---|---|
| 139444993 | `SHA256[0:12]`, `neo-2.28` | `ffdb3743c1c8` resolves to version 3214341 |
| 138775138 | 3 LoRAs, 1 matching | `7e5a17e35800` keeps resolving to 365933; other two resolve; **two** unmatched reported, not one |
| 139934636 | local-only LoRA | still resolves to **nothing** — matching it means the comparison is too loose |
| 135566724, 119372854 | `0x` prefix | unchanged until the algorithm is identified |
| 139830592 | `neo-2.28`, matches today | unchanged — the A/B partner for 139444993 |
| 140087915 | 5 LoRAs, mixed outcomes | multi-resource regression case |
| 140039335 | mojibake in a LoRA name | unrelated UTF-8 decoding case, noted in passing |

A fix is correct when the majority path (85–88% of references, matching `AutoV3` today) is provably
unchanged. That negative control matters as much as the positive ones: the failure mode of a
prefix-matching fix is over-matching, which is silent.

---

## Deliberately out of scope

The same confirm step would also close the pre-existing 10-character exposure on **checkpoint**
matching — the `"model": "…"` path, which carries most detection volume. That is a behaviour change
to the working majority path in service of a bug about LoRAs, so it belongs in its own change where
a regression cannot be misattributed to this one.
