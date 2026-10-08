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

## 3. Why it cannot be cheap

Three measurements, each of which removes an option.

**ClickHouse cannot supply it.** `images` carries `userId` and a `resources` array, but in the last
30 days it holds only `Delete`, `DeleteTOS` and `Restore` events — no creates. `images_created` has
`id, mediaType, createdAt, nsfw, userId, version, nsfwLevel` and **no resources**. So the
image→resource link exists only in Postgres.

**The Postgres source is large.** `ImageResourceNew` is **453 million rows / 42 GB**, indexed on
`("modelVersionId", "imageId")`.

**A periodic full rollup is not a small job.** A set-based aggregate — `ImageResourceNew` joined to
`Image` and `Post`, grouped by `modelId` with `count(DISTINCT "userId")` — did not finish inside the
replica's 60-second statement timeout for a **single 100,000-wide `modelId` slice**. The per-model
correlated form runs about 0.5 s/model, which is days for a full pass. Neither is a job we can run
hourly.

There is also a dead precedent: `ModelVersionMetric.imageCount` has a rollup for almost exactly this
query, **commented out** in `src/server/metrics/model.metrics.ts`. It was disabled in `212656ff4d`
(2025-03-13), whose message is "check in" — the reason is not recorded. That rollup had the right
shape, including `m."userId" != i."userId"` to exclude the creator's own gallery. Finding out why it
was switched off is step 0; if it was cost, that is the same wall as above, and reviving it unchanged
would hit it again.

## 4. Design: maintain it incrementally, backfill once

The read has to be O(1) at feed time, so the count is stored and kept current by writes, never
aggregated on demand.

### A pair table

```sql
CREATE TABLE "ModelUniquePoster" (
    "modelId" INT NOT NULL,
    "userId"  INT NOT NULL,
    PRIMARY KEY ("modelId", "userId")
);
```

One row per (model, person who has published an image with it). Sized from the sample — a median of
1 poster per model with a heavy tail, call it single-digit millions of rows, which is small next to
the 453 M it summarises.

### Maintained on post publish, not on resource insert

A trigger on `ImageResourceNew` is the wrong hook: the row exists before its post is published, and
publication is the event that makes an image count. The write belongs where a post is published —
walk that post's images' resources and `INSERT … ON CONFLICT DO NOTHING` one pair per
(model, poster), skipping the model's own owner.

The volume makes this free: **2.7 M images from 37,799 posters in 30 days** (~90 k/day, about one per
second), and a post carries at most a few dozen resource links.

### A counter column, so the existing trigger does the rest

```sql
ALTER TABLE "ModelMetric" ADD COLUMN "uniquePosterCount" INT NOT NULL DEFAULT 0;
```

Then add `uniquePosterCount` to `model_metric_hot_score()`'s expression and to its
`BEFORE INSERT OR UPDATE OF` column list. Everything downstream is unchanged: the score stays
trigger-owned, the `ModelBaseModelMetric` mirror copies `hotScore` and needs no edit, and the
migration keeps the apply-before-deploy property that made the Hot sort shippable
(`model-feed-hot-ranking.md` §11).

### The one-time backfill is the expensive part

Populating `ModelUniquePoster` from 453 M rows is a single offline pass, batched by `modelId` with a
commit per batch, run as a script rather than inside the migration. **Trial it on dev and measure
before scheduling anything on prod** — §3 says a 100 k-wide slice exceeds 60 s, so this is hours at
least, and the batch width and index strategy should come from a measured run, not an estimate.

## 5. Open questions

1. **Why was the `imageCount` rollup disabled?** Blocking. If it was cost, that constrains the
   backfill; if it was correctness, that may constrain the definition.
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
2. **Trial the backfill on dev** — pair table, batched population, measured.
   *Closing condition:* a measured wall-clock for a full dev pass, and a batch size that holds row
   locks for under a second.
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
