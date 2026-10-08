# Unique posters as a Hot signal

Status: **plan**, 2026-10-08. Nothing is built. Proposed as the follow-up to the Hot sort
([model-feed-hot-ranking.md](model-feed-hot-ranking.md)), which shipped with three signals — likes,
downloads, generations. This adds a fourth: how many **distinct people** have posted an image made
with the model.

Raised by a tester during the Hot round: *"I would recommend it being images posted per unique user.
Some of my LoRAs have just one dude posting like 50 images a day."* Both halves of that turned out to
be measurably right.

---

## 1. Why this signal

The three shipped signals all measure *acquisition* — someone liked it, downloaded it, or ran it.
None measures whether a variety of people made something they thought was worth publishing. That is
the closest thing on the site to a quality vote with effort behind it, and it is the one signal a
creator cannot generate alone.

It also covers a gap a tester named directly: a model used mostly **off-site** earns downloads but no
generations, and today downloads are its only evidence. An image posted here from an externally
generated result is the one place that usage becomes visible.

## 2. Unique posters, not image count

Raw image count is dominated by single users. Measured over a 400-model sample of published models
with 20+ likes:

| | median | 90th percentile |
| --- | ---: | ---: |
| Share of a model's third-party images from its single biggest poster | **67%** | **100%** |

For a tenth of models, *every* third-party image comes from one person. The tester's "one dude
posting 50 images a day" is the typical case, not the exception.

Counting distinct posters instead removes that leverage, and it ranks better. Simulated over the 700
strongest candidates published in the last 200 days, on top of the corrected divisors:

| | Illustrious /100 | First Illustrious-only | Qwen/H3/Krea 2 | 500+ generations | Median images | Median posters |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| divisors only (shipped) | 33 | rank 4 | 55 | 56 | 29 | 5 |
| + raw images, equal weight | 26 | rank 7 | 63 | 58 | 200 | 13 |
| + raw images, 1/8 weight | 30 | rank 5 | 57 | 62 | 92 | 8 |
| + unique posters, equal weight | 25 | rank 5 | 58 | 43 | 95 | 11 |
| **+ unique posters, 1/8 weight** | **34** | **rank 4** | **55** | 55 | **45** | **7** |

Only the last row improves the feed's real-usage quality at no cost to the base-model mix — median
images in the top 100 goes 29 → 45 while Illustrious holds at 33–34. Raw images cost 3–7 Illustrious
slots, because a new ecosystem's launch generates showcase posts and so correlates with novelty, the
same trap the download divisor fell into (`model-feed-hot-ranking.md` §13).

**The weight is not settled.** 1/8 of equal weight came out of one simulation against a bounded
candidate pool. It gets a proper sweep once the real column exists.

## 3. Where the count can come from

Three measurements, and one piece of history that turned out to matter more than any of them.

**ClickHouse cannot supply it.** `images` carries `userId` and a `resources` array, but in the last
30 days it holds only `Delete`, `DeleteTOS` and `Restore` events — no creates. `images_created` has
`id, mediaType, createdAt, nsfw, userId, version, nsfwLevel` and **no resources**. So the
image→resource link exists only in Postgres.

**The Postgres source is large.** `ImageResourceNew` is **450 million rows / 42 GB**, indexed on
`("modelVersionId", "imageId")`. The dev database holds a full-size copy, so dev timings carry over.

**A one-shot full aggregate is not viable.** The set-based form — `ImageResourceNew` joined to
`Image` and `Post`, grouped by `modelId` with `count(DISTINCT "userId")` — did not finish inside the
prod replica's 60-second statement timeout for a **single 100,000-wide `modelId` slice`**. The
per-model correlated form runs about 0.5 s/model, which is days for a full pass.

### The history: this was built once and abandoned mid-migration

`ModelVersionMetric.imageCount` has a rollup for nearly this exact query, **commented out** in
`src/server/metrics/model.metrics.ts`. It was disabled in `212656ff4d` (2025-03-13), whose message
is "check in". The reason is not in the message, but the surrounding commits make it plain:

- the dead code reads the **old `"ImageResource"` table**;
- the very next commit on that file is `90032c5489`, *"code changes and migration for table
  ImageResourceNew"*;
- nothing under `src/server/metrics/` references the old table any more;
- `ModelVersionMetric.imageCount` is nonzero on only **86,152 of 1,174,457** rows, frozen since, while
  the table's other columns were updated minutes ago.

So it was not switched off for cost. It was commented out while the table underneath it was being
replaced, and never re-pointed at the new one. That answers §5.1 and changes the design below.

**And the dead rollup was already incremental.** It does not scan anything: `getAffected(ctx,
'ModelVersion')` selects only the versions whose images were posted since the job's last run, and
recomputes just those. That is exactly the mechanism this plan was going to build from scratch —
ongoing maintenance is already solved, in code, in this repo.

## 4. Design: revive the rollup, don't build a new one

### What changes from the dead version

1. **Read `ImageResourceNew`** instead of `"ImageResource"`. That is the whole reason it is dead.
2. **Aggregate per model, not per version.** `count(DISTINCT "userId")` does not sum: a person who
   posts for v1 and v2 is one poster, so per-version uniques cannot be added up. The target is
   `ModelMetric`, not `ModelVersionMetric`.
3. **Count distinct posters, not images** — `count(DISTINCT i."userId")` in place of the image count.
   §2 is why.
4. **No timeframes.** `ModelVersionMetric` carries a `timeframe` column; `ModelMetric` does not, so
   this is all-time only and the `CROSS JOIN enum_range` and `timeframeSum` machinery goes away.

Everything else carries over unchanged, including `m."userId" != i."userId"` to exclude the creator's
own gallery and the published-post predicate — both already correct in the dead code.

### A counter column, so the existing trigger does the rest

```sql
ALTER TABLE "ModelMetric" ADD COLUMN "uniquePosterCount" INT NOT NULL DEFAULT 0;
```

Then add `uniquePosterCount` to `model_metric_hot_score()`'s expression and to its
`BEFORE INSERT OR UPDATE OF` column list. Nothing downstream changes: the score stays trigger-owned,
the `ModelBaseModelMetric` mirror copies `hotScore` and needs no edit, and the migration keeps the
apply-before-deploy property that made the Hot sort shippable (`model-feed-hot-ranking.md` §11).

A `NOT NULL DEFAULT 0` column also means the score stays valid from the moment the column exists —
every model simply scores as though nobody has posted for it until the backfill fills it in.

### The one-time backfill: measured, and the obvious shapes are the slow ones

The incremental task keeps the column current *going forward*; it does not populate 722,738 published
models' history. That is the one expensive job, and two plausible shapes for it are both unusable.

**Set-based, sliced by `modelId` — unusable.** A single 50,000-wide slice did not finish in 5 minutes
on dev. `EXPLAIN` shows the planner ignoring `("modelVersionId", "imageId")` entirely:

```
GroupAggregate
  -> Gather Merge -> Sort (rows=10,846,319)
       -> Parallel Hash Join
            -> Parallel Seq Scan on "ImageResourceNew"  (rows=187,816,667)
            -> Parallel Index Only Scan on "ModelVersion"  (rows=13,574)
```

It hash-joins all 42 GB against the slice's versions, correctly — those versions own millions of
image rows between them and a scan beats that many index descents. So **every slice pays for a full
table scan**, and sixty slices scan 42 GB sixty times. The batching that makes the `hotScore`
backfill safe makes this one quadratic.

**Set-based, narrowed to recent models — also unusable, and for a different reason than expected.**
Restricting to models published in the last 90 days still times out, and still seq-scans: the plan is
the same shape. Selecting fewer models does not stop the planner hash-joining the whole table. Set
size is not what decides the access path here.

**Per-model `LATERAL` — this is the one.** A correlated subquery per model forces the index, whatever
the set size. Measured on dev, 300-model samples:

| Model age | Cost per model | Median posters | Max |
| --- | ---: | ---: | ---: |
| under 90 days | **8 ms** | 0 | 51 |
| 1–2 years | 74 ms | 2 | 3,260 |
| over 3 years | 36 ms | 1 | 1,441 |

Old models cost more because they own more images. Extrapolated, single-threaded:

| Scope | Models | Estimated |
| --- | ---: | ---: |
| published in the last 90 days | 62,896 | **~8 minutes** |
| published in the last 180 days | 119,691 | ~15–30 minutes |
| every published model | 722,738 | ~8 hours |

So the full backfill is feasible after all — hours, not days, and parallelisable by `modelId` range
across a few workers. The narrow one is minutes. Either works; start narrow, because the feed cannot
surface a model older than about six months anyway (the live top 100 reaches back 69 days,
`model-feed-hot-ranking.md` §13) and the incremental task picks up anything that gets a new post
later.

A secondary cost, once the access path is right: `count(DISTINCT "userId")` forces a `GroupAggregate`
over a large sort. Pre-aggregating with `GROUP BY "modelId", "userId"` and counting groups avoids it.

### The signal is sparse where the feed looks

Worth knowing before tuning the weight: **the median model under 90 days old has 0 unique posters**,
and the maximum in that sample was 51. The 1–2 year cohort has a median of 2 and a maximum of 3,260.

So on a recency-weighted feed this signal is silent for most of the models in contention and speaks
only for the ones that have picked up real third-party use. That is arguably what it should do — it
is a bonus for traction, not a baseline — but it means it cannot do much work at the very top, and a
weight tuned against the §2 simulation may overstate its reach on live data. Re-measure after the
backfill, not before.

### What a pair table would have bought, and why it is not needed

An earlier draft proposed `ModelUniquePoster (modelId, userId)` maintained on post publish. With the
incremental rollup alive, that is redundant machinery: it solves ongoing maintenance, which is
already solved, and it does not help the backfill, which is the part that costs. It would only earn
its keep if deletes have to decrement exactly — see §5.4.

## 5. Open questions

1. ~~**Why was the `imageCount` rollup disabled?**~~ **Answered** (§3): abandoned mid-migration when
   `ImageResource` became `ImageResourceNew`, not a cost or correctness decision.
2. **Sockpuppets.** Unique posters is harder to game than image count but not free — the attack is
   one image each from many throwaway accounts, and it is *cheaper* than the attack it replaces.
   Likely needs a floor on which accounts count (age, or some prior activity). Needs its own look
   before this ships; the 1/8 weight limits the payoff but does not remove it.
3. **Declared vs detected resources.** `ImageResourceNew.detected` distinguishes a resource the
   poster declared from one inferred from metadata. Unclear which should count.
4. **Deletes and unpublishes.** Decrementing is not a simple `DELETE` — a poster may have other
   published images using the model. Options: leave counts monotonic, or recompute the affected
   models lazily on the metrics job. Monotonic counts drift upward over time, which biases toward
   older models and partly undoes the recency design.
5. **All-time or windowed?** This plan is all-time, matching the shipped signals. A 30-day window
   would answer a different question and belongs with §6.

## 6. This is half of a larger piece

Three other things testers asked for need the same missing capability — a scheduled rollup of
recent, per-model activity:

| Ask | What it needs |
| --- | --- |
| Rank on recent metrics, not all-time | a 30-day engagement window (ClickHouse has downloads: 33.6 M events, 641 k models) |
| Let an old model pop off | the same window |
| Stop perennial winners being permanently hot | baseline normalization of that window — rank on lift over a model's own history, not absolute volume |
| Unique posters (this doc) | a unique-poster rollup on the same schedule |

Built separately they are four half-measures that fight each other, which is exactly what the
raw-images row in §2 demonstrates. They should share one design pass and one rollup.

Note that the third is what keeps the second safe: a straight 30-day engagement ranking would park
the site's biggest checkpoints on top permanently, which is the failure a tester predicted. Under the
shipped publish-date design it cannot happen — WAI-Simple-Illustrious ranks 973 today, 276 after the
divisor fix — so that risk arrives *with* the window, not before it.

## 7. Phasing

1. **Establish why the old rollup was disabled**, and decide declared-vs-detected and the delete
   policy (§5.1, §5.3, §5.4).
   *Closing condition:* each of the three written down in this doc with a decision and a reason.
2. ~~**Trial the backfill on dev.**~~ **Done** — per-model `LATERAL`, 8 ms/model for recent models,
   ~8 minutes for the 90-day scope. The set-based shapes were measured and rejected (§4).
3. **Tune the weight** against the real column, as a sweep rather than a single simulation.
   *Closing condition:* a table like §2's across at least five weights, chosen on the base-model mix
   and the generation-heavy count together.
4. **Ship** — migration (column, trigger expression, trigger column list), the post-publish write,
   the backfill script.
   *Closing condition:* the migration applied to prod ahead of the deploy, 0 rows with a NULL or
   stale count, the feed's `EXPLAIN ANALYZE` unchanged, and a re-measure of the §2 table on live
   data.
5. **Sockpuppet floor** (§5.2) before or with step 4, not after.
   *Closing condition:* a stated rule for which accounts count, and a measurement of how much of the
   current top 100 it moves.
