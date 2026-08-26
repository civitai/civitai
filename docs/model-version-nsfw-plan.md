# Marking model versions NSFW — plan

**Status**: §1–§3 and §5 built and tested · §4 (read-side filtering) not started · migration unapplied · **term list seeded in production** (see §6)
**Related**: [Model Text Moderation](features/model-text-moderation.md)

A model's own name and description already have a path to an NSFW flag. A **version** name does
not, and a version name renders on civitai.com in places the model's rating never reaches.

---

## 1. What was decided

- A flagged version **does not take the model down** while the model still has unflagged
  published versions. If *every* published version is flagged there is no safe version left to
  show, so the model itself goes NSFW.
- A flagged version **is not viewable on civitai.com**. Reaching its page there gets the same
  civitai.red redirect an NSFW model already gets.
- **No Meilisearch rebuild** — a queued document update, nothing more.
- **A version under a system-owned model is never flagged.** See §3.5.
- **The term list decides and XGuard reviews.** A match flags the version at save time; the scan
  that follows can overturn it and can do nothing else. See §5.

---

## 2. What reads a version's level today

`ModelVersion.nsfwLevel` is read by two paths, and it is worth being precise about which,
because the difference decides how much §4 has left to do:

- The **public version endpoint** filters it against the viewer's allowance. So a stamped
  version disappears from that endpoint as soon as the flag is written, ahead of §4.
- The **licence check** drops versions whose level intersects the NSFW composite from
  licence-restricted base models. Same timing.

Everything else that renders a version name treats the level as metadata, not as a visibility
control: the model page's version list, the default version chosen when none is given, the
generator's resource cache, the public list endpoint and the download path. That is §4's work —
§4.1-§4.5, one per surface.

⚠️ **Consequence for the rollout:** §6's steps are inert only while nothing writes the flag.
The first write has visible effects through those two paths before any of §4 ships.

---

## 3. Schema, derivation, rollup — **built**

### 3.1 Column

`ModelVersion.nsfw`, `BOOLEAN NOT NULL DEFAULT FALSE`, with a partial index keyed on
`("modelId") WHERE "nsfw"`.

The index is keyed on `modelId`, not on `nsfw`: the predicate already restricts every entry to
the true side, so keying on that column stores a constant and the index degenerates to an
unordered tid list. `modelId` is the same width and serves both the per-model lookup and an
ordered sweep.

Not declared in `schema.full.prisma` — Prisma cannot express a partial index, and declaring a
full one would describe an index we do not create. That matches the other partial indexes in
the migrations directory.

🔴 **The migration must be applied BEFORE the code deploys.** Three raw SQL statements and the
generated client reference `nsfw`; against a database without the column the one-minute
`update-nsfw-levels` cron dies on an undefined column and full-row version reads fail with it.
This is the opposite ordering from an additive enum, where the deploy goes first.
`CREATE INDEX CONCURRENTLY` cannot run inside a transaction — run it as its own statement.

### 3.2 The flag is an input to the level

`nsfw` joins the existing `CASE` in `updateModelVersionNsfwLevels`, beside `m.nsfw`, and stamps
the NSFW composite. This is how `Model.nsfw` already behaves, and it is why `ModelVersion` needs
no lock column: the recompute cannot clobber a flag it reads as one of its own inputs.

### 3.3 The rollup excludes flagged versions

```sql
bit_or(mv."nsfwLevel") FILTER (WHERE NOT mv.nsfw) "safeLevel",
count(*)               FILTER (WHERE NOT mv.nsfw) "safeCount"
```

`FILTER`, not `WHERE mv.nsfw = FALSE`, because the all-flagged case has to stay
distinguishable. Under a `WHERE` the group vanishes, the `FROM level WHERE level.id = m.id` join
finds nothing, and the model keeps its old level indefinitely. Under `FILTER` the row survives
with `safeCount = 0`, which a `CASE` turns into the NSFW composite — not `NULL`, and not `0`,
which reads as *unrated* and which the gating gives its own UI.

⚠️ **There are THREE copies of this rollup**, and all three needed the `FILTER` — the third
needed one more edit besides:

| | |
| --- | --- |
| `nsfwLevels.service.ts` | canonical, every minute |
| `jobs/temp-set-missing-nsfw-level.ts` | models at level 0, every 10 minutes (its *version* half is dead — see §3.4) |
| `pages/api/admin/temp/migrate-nsfwLevels.ts` | manual, by id range — **also needed `AND mv.status = 'Published'`** |

Nothing links them; they are found by grepping for `bit_or`. Miss the second and the exclusion
is undone every ten minutes by a job nobody was looking at. Miss the third and a single manual
invocation undoes it for a whole id range.

The third copy never filtered on `Published`, which was harmless under a plain `bit_or` — a draft
sits at 0 and contributes nothing. Under `safeCount` it stopped being harmless: one unflagged
draft makes `safeCount` non-zero, suppresses the all-flagged fallback, and writes 0 where the
other two write the NSFW composite.

### 3.4 The flip trigger

The cron drains `JobQueue`; it does not scan for stale rows. There is no backstop behind it: the
version half of `temp-set-missing-nsfw-level` is dead code — its `WHERE` is pinned to one
hardcoded id and never references its own CTE. (That predates this work; only the model-rollup
half of that job runs.) **A flag written with no queue row is never picked up.**

So the `ModelVersion` trigger fires on `nsfw IS DISTINCT FROM` — **in both directions** — and
enqueues **the version only**. `getModelVersionConnectedEntities` derives the parent model from
it, and the cron rolls models up after versions inside the same tick, so enqueuing the model as
well is a duplicate rather than a safety net.

Both directions, and `IS DISTINCT FROM` rather than `!=`, are load-bearing: the same shape on
`Model` once left versions stamped after a true→false flip, which froze the model rollup at that
level indefinitely.

### 3.5 System-owned models are refused at the write

The version `CASE` has no `ELSE`. For a model on the system account with both flags false it
yields `NULL`, the update's `!=` guard is never true, and the row keeps its level. Setting the
flag there is therefore a **one-way door** — clearing it leaves the version stamped forever, and
that rolls into the parent.

There is no agreed level to recompute such a version back to, so the trap is closed at the write
rather than repaired: a `BEFORE INSERT OR UPDATE OF "nsfw"` trigger raises if the flag is set on a
version whose model is system-owned. INSERT and not only UPDATE, because the writers this guard
exists for can insert the row already flagged — and once it exists in that state no later update
of the column ever fires to catch it.

Enforced in the database rather than in application code. The live writer is the adapter in §5,
which excludes system-owned models in its own `WHERE` — but a guard that only lives there would
not see a hand-run backfill or a moderator tool, and this is a trap with no way back out.

---

## 4. Not viewable on civitai.com — **not started**

### 4.1 The redirect already exists — feed it the version

The gating hook already returns `'redirect'` for an NSFW model and sends the viewer to the same
path on civitai.red. The model page already mounts it with the model's flag and level.

**The change is to OR the selected version's flag into that decision.** Nothing else: the
redirect target is built from the current path, so the query string carrying the version id
survives and the viewer lands on the version they asked for. The owner/moderator bypass already
in place covers their own view.

### 4.2 Default version selection

The helper that picks a version when none is given selects status, publication and availability
— no level, no flag. Left alone, a bare model link on the SFW domain can pick a flagged version
and redirect a model whose other versions are perfectly safe.

### 4.3 Version list

The model page's switcher filters on published status alone. A flagged version should not appear
in it at all on the SFW domain, rather than being present but unselectable.

### 4.4 Generator resource picker

The generator's resource cache carries the version name with no level. Either add the flag to the
cached shape — a cache-shape change, so it needs a bust — or exclude flagged versions from the
cache. Decide alongside §7's question about generation.

### 4.5 Public API and downloads

The list endpoint and the download path both surface version names; a name reaches people
through a filename as well as a page.

---

## 5. How versions get flagged — **built**

**Automatically, on create and rename.** `model-version-moderation.adapter.ts` registers under
`ModelVersion` in the shared moderation-adapter registry, which is the entire callback wiring —
the existing text-moderation webhook dispatches by entity type, and the retry cron reads the
same map. No new endpoint was needed.

The path is: curated term list (local regex, every save) → `ModelVersion.nsfw` set on the spot →
XGuard on the same name → the verdict can overturn it. The name is scanned **alone**; §5.1
explains why the description is not.

**The list DECIDES and the scan REVIEWS**, in that order. XGuard reads a two-word title poorly —
§5.2 has the measurements — so it is not usable as the thing that decides. It is good at the
narrower question asked here: given a name the list already matched, is the list wrong? So
`applyResult` only ever CLEARS. Nothing downstream of the term list can raise the flag, which is
also why a moderator's decision cannot be undone by a callback arriving late.

**Failure leaves the flag on.** A submit that fails, or a callback that never arrives, means the
review never happened and the list's verdict stands. That is the safe direction here, and it is
why the moderator clear path is required rather than optional.

**The term list lives in system Redis**, not in this repository — editable without a deploy, and
a decision rule rather than configuration. An empty list is the off switch: nothing is flagged,
scanned or cleared, and the retry cron reports the adapter disabled rather than burning retry
budget against it. The off switch is checked *before* the term match, not after — a match and an
unconfigured list both produce no terms, and reading the second as "this name is clean" would
strip every standing flag on the next save.

There are **no feature flags**, and no separate arming switch: seeding the list turns the feature
on. The cost is that there is no shadow phase — the first flag lands on live content the moment
the list is seeded.

### 5.1 Why the description is not scanned

- The flag exists because the **name** displays. Including the description changes the question
  to "is this version adult", which is wrong in both directions.
- The description is already scanned one layer up, where it sets `Model.nsfw` — and a flagged
  model already stamps every version through the `m.nsfw` branch. Scanning it here double-counts.
- Only 23.1% of versions have one (155,560 of 674,186 actionable), so including it would make
  the flag mean different things for different creators.

### 5.2 Why XGuard reviews rather than decides

Measured over 2,000 random version names: XGuard returns `suggestive` **0.55–0.69** for
contentless strings like `v1.0`, clearing its own 0.50 threshold. **98.3% of its triggers sat in
that band**; only 2 of 2,000 reached 0.85. Asked to decide, it would flag four names in five on
its own noise floor. That is what the term list is for.

Asked instead whether a name the list already matched is a false positive, it is reliable: over
the first full sweep it overturned 24 of 2,620 matches and a human ruled *do not flag* on all 24.

**There is no score floor, and re-adding one would be a regression.** A floor belongs on a path
where the classifier decides. Here the comparison is XGuard's own per-label thresholds — exactly
the one the 24-for-24 record was measured on — and a floor stacked on top of it would clear every
verdict below the floor. With 98.3% of triggers in the 0.50–0.70 band, an 0.85 floor would
quietly overturn nearly everything the list flagged.

### 5.3 The sweep tooling

`scripts/oneoffs/model-version-name-sweep.ts` is the measurement tool, not the live path. Four
phases against one workbook: term sweep → XGuard comparison → a review tab of disagreements →
a random control sample of non-matching names. Phases 2 and 4 are resumable — rows with a
verdict are skipped and the workbook saves every chunk.

**Measured on the first full run:** 1,211,799 versions scanned, 2,620 term matches, **448
actionable**. Of those, 2,596 of 2,620 agreed with XGuard (99.1%); all 24 disagreements were
ruled *do not flag*, so the classifier was right in every contested case — and two of them were
term-list faults rather than judgement calls (an acronym, and a car chassis code).

⚠️ **The miss rate is still unmeasured.** The control sample established that XGuard is unusable
on contentless names, not how much the term list misses. Phase 4 is what will put a number on it.

### The search index

`updateModelVersionNsfwLevels` now queues the parent model's document from its own `RETURNING`.
It previously queued nothing, which was survivable only while a version change always dragged a
model change along in the same tick — under §3.3 it no longer does. A queued update, not a
rebuild: the indexed document already carries the per-version level, version names are not
searchable, and model cards do not render them.

---

## 6. Rollout

🔴 **The term list is already seeded in production** — 89 triggers, 10 phrase patterns, 5
carve-outs, written 2026-08-26 with `scripts/oneoffs/seed-model-version-name-terms.ts`. Arming
was step 4 precisely so it would come last; it is now first. Nothing reads the key while the
column does not exist and this branch is undeployed, so it is inert today — but **the deploy is
the moment flagging begins**, with no further action and no opportunity to stage it.

1. **Apply the migration.** Not optional and not reorderable — see §3.1. Raw SQL and the
   generated client both reference the column; deploying the code first takes the level cron
   down.
2. **Ship the code — this is the live step**, not an inert one, because of the seeding above.
   Every save of a version whose name matches a term flags it on the spot from here on.
3. Read-side filtering (§4).

Step 3 is a no-op **subject to the §2 caveat** — the surfaces that already filter a version by
its level react the moment a flag is written, ahead of §4.

⚠️ **The seeded list carries its two known-bad terms** (§5.3): `ass`, which matched the acronym
of *Anime Screencap Style*, and `r34`, which matched a Nissan Skyline LoRA. Both were deliberately
kept — XGuard overturned both in the sweep, so they exercise the clear path rather than producing
standing false positives. Each still flags at save time and spends a scan before being cleared.

---

## 7. Still open

- **Does a flagged version block generation?** Its files remain downloadable and it is still
  usable by id. A name is not a reason to break generation — but whether the picker offers it
  (§4.4) is a different question from whether the API accepts it.
- **Is the creator told?** Neither path tells them anything today. A creator who renames to a
  name the list does not match clears the flag themselves without ever learning it existed.
- **The term list has no measured miss rate.** See §5.3 — the blind spot is real and unquantified.
- **The two rollups disagree on the value they stamp.** The service uses the NSFW composite; the
  ten-minute job uses a literal that omits one bit. The divergence predates this work and is
  pinned by a test rather than resolved.
