# Scanner Prompt Tuning — Context

This doc captures the moving pieces involved in tuning the prompts/policies we send to our content-moderation scanners. It's written as orientation for future Claude sessions — read this before touching scanner code or designing review/analysis tooling.

The **goal of this project**: record scanner inputs + outputs in a structured way so moderators can mark false positives and we (or an AI) can analyze patterns to adjust the scanner prompts/policies.

This is logically a **separate project** from operational moderation — different audience (tuning team vs. trust & safety operators), different data shape (append-only analytics vs. low-latency operational state), different storage tech. It will live inside the civitai repo for now (no standalone service), but with isolated boundaries so it can be extracted later.

---

## Refinement lifecycle

Tuning a scanner label is a four-phase loop. Each pass through the loop tightens the policy. The rest of this doc describes the dataset infrastructure (phase 2) in depth; this section is the framing for *why* that infrastructure exists and where the other phases happen.

### Phase 1 — Define the label/policy

A new label starts orchestrator-side, not in civitai. The civitai workflow only needs to know the label's name so it can be requested in `workflow.metadata.labels`.

What gets authored in phase 1:

- **Label name** — short identifier (`csam`, `nsfw`, `impersonation`, …) that goes in the workflow request.
- **Policy text** — natural-language description of what makes the label apply (`x`) vs. not (`sec`). For XGuard, this is the `chatTemplateKwargs.policy` string that gets fed into the model on every call.
- **Threshold** — initial cutoff on the first-token-probability score (educated guess; this is what phase 3 dials in).
- **Mode applicability** — does this label run on prompt mode, text mode, or both?

The orchestrator stamps each evaluation with a `policyHash` derived from the exact policy text. That hash becomes the `version` column on `scanner_label_results`, which is what makes A/B comparison in phase 3 work without civitai-side bookkeeping.

For image scanners, "defining a label" means adding a new `include*` flag to the `mediaRating` step input and a corresponding output field (see [image-scan-result.service.ts](src/server/services/image-scan-result.service.ts) and the `TagSource` enum). Versioning is currently a `'1'` placeholder until the orchestrator surfaces per-result version info.

### Phase 2 — Provide a dataset

This is what we built. Production traffic flows through the scanner with `metadata.recordForReview = true`, each scan emits per-label rows into ClickHouse `scanner_label_results`, and moderators review items in the focused-review UI (`/moderator/scanner-audit/[mode]/[label]`).

Every verdict produces three pieces of permanent data joined by `(contentHash, version, label)`:

1. The audit row in `scanner_label_results` — score, threshold, triggered flag, matched terms, occurrences.
2. The verdict row in `ScannerLabelReview` — TP / FP / TN / FN / Unsure (see verdict matrix below).
3. The `ScannerContentSnapshot` JSON — text/prompt/imageId + per-label `modelReason`. Snapshotted at verdict time so it survives the orchestrator's 30-day TTL.

After ~a week of mod review against a new policy, you have a labeled corpus of `(content, model decision + reasoning, human judgment)` triples scoped to that `version`. That's the input to phase 3.

**Verdict matrix** — "positive" here means "the model triggered," not "the content is bad." We're judging the model's call, not the content directly.

|                            | Mod says: should trigger          | Mod says: should NOT trigger     |
|----------------------------|-----------------------------------|----------------------------------|
| Model **triggered**        | **TP** — correct fire             | **FP** — false alarm             |
| Model **did not trigger**  | **FN** — escape (missed it)       | **TN** — correctly held back     |

In the focused-review UI the mod's two answers map straight to the matrix: **Yes** = "label should have triggered," **No** = "label should not have triggered." `verdictFromAnswer` ([src/pages/moderator/scanner-audit/[mode]/[label].tsx](src/pages/moderator/scanner-audit/[mode]/[label].tsx)) combines that with the row's `triggered` flag to produce the verdict.

Tuning interpretation:

- High **FP** → policy too broad. Look at FP `matchedText` + `modelReason` to find what the policy is over-claiming on, then carve it out.
- High **FN** → policy too narrow, or threshold too high. Look at FN content + near-miss gap distribution to find what's slipping through.
- **TP** + **TN** rates climbing across versions is the proof a refinement worked.
- **Unsure** is a valid answer for genuinely ambiguous cases. Excluded from FP/FN-rate denominators so it doesn't pollute the metric.

### Phase 3 — Review signals against the dataset

Phase 3 is analysis — querying the dataset to surface where the policy is wrong and what kind of wrong. The interesting cuts:

**FP/FN rates per (label, version).** Headline metric. Excludes `Unsure` from the denominator.

```sql
-- App-side join: CH `scanner_label_results` ⨝ PG `ScannerLabelReview`
-- Run as: pull verdict counts from PG, pull triggered counts from CH, join
-- in TypeScript or in BI tooling. We don't have native cross-source joins.
SELECT label, version,
  count(*) FILTER (WHERE verdict = 'TruePositive')  AS tp,
  count(*) FILTER (WHERE verdict = 'FalsePositive') AS fp,
  count(*) FILTER (WHERE verdict = 'TrueNegative')  AS tn,
  count(*) FILTER (WHERE verdict = 'FalseNegative') AS fn
FROM "ScannerLabelReview"
WHERE verdict <> 'Unsure'
GROUP BY label, version;
```

**Near-miss gap distribution.** For each (label, version), histogram of `threshold - score` on untriggered rows. Tells you whether the threshold is sitting in a dense or sparse part of the score distribution — if there's a cluster of near-misses just below threshold that mods consistently mark `FalseNegative`, the threshold is too high.

```sql
-- Untriggered score-vs-threshold gaps for label 'csam' in last 30 days
SELECT round(gap * 100) / 100 AS gap_bucket, count() AS n
FROM (
  SELECT anyLast(threshold) - anyLast(score) AS gap
  FROM scanner_label_results
  WHERE lastSeenAt > now() - INTERVAL 30 DAY
    AND label = 'csam'
  GROUP BY contentHash, version, label
  HAVING max(triggered) = 0 AND anyLast(threshold) IS NOT NULL
)
GROUP BY gap_bucket
ORDER BY gap_bucket
SETTINGS prefer_column_name_to_alias = 1;
```

**Matched-term clusters on FPs.** If a label keeps misfiring on the same trigger words, the policy needs to carve out those contexts.

```sql
SELECT term, count(*) AS fp_count
FROM (
  SELECT unnest(slr.matchedText || slr.matchedPositivePrompt || slr.matchedNegativePrompt) AS term
  FROM scanner_label_results slr
  JOIN scanner_label_review rev USING (contentHash, version, label)
  WHERE rev.verdict = 'FalsePositive' AND slr.label = 'csam'
)
GROUP BY term ORDER BY fp_count DESC LIMIT 20;
```

**modelReason corpus per verdict class.** The text the model wrote about each scan is now persisted in `ScannerContentSnapshot.content.labelReasons[label]`. Feed all `FalsePositive` reasons for a label into Claude alongside the policy text and ask "what about this policy is causing these specific kinds of mistakes?" — the model's own self-justifications are the highest-signal input you have for phase 4.

**Cross-version comparison.** Same content, different `version`, lets you measure whether a policy change actually moved the needle on the *same items*.

```sql
-- Items scanned under both v1 and v2 of the csam policy
SELECT contentHash, version, max(triggered), anyLast(score), anyLast(threshold)
FROM scanner_label_results
WHERE label = 'csam' AND lastSeenAt > now() - INTERVAL 60 DAY
GROUP BY contentHash, version
HAVING contentHash IN (
  SELECT contentHash FROM scanner_label_results
  WHERE label = 'csam' AND lastSeenAt > now() - INTERVAL 60 DAY
  GROUP BY contentHash HAVING uniq(version) >= 2
)
SETTINGS prefer_column_name_to_alias = 1;
```

### Phase 4 — Clarify/refine the label/policy

Phase 4 happens orchestrator-side again. The output of phase 3 — concrete failure modes, matched-term clusters, modelReason patterns, FP/FN counts — is the input to a policy edit. Either a human rewrites the policy text, or an AI proposes a rewrite from the FP-reason corpus and a human reviews.

Once the new policy text lands in the orchestrator:

- The orchestrator emits a new `policyHash`.
- New scans land in `scanner_label_results` with the new `version` column.
- Old verdicts in `ScannerLabelReview` are still keyed to the *old* version — they remain valid evidence of how v1 performed, but don't carry forward to v2.
- The same content scanned under v2 produces a new row; mods can re-verdict (or not) those rows separately, which is how the FP/FN comparison in phase 3 closes the loop.

Threshold-only changes don't change `policyHash`, so threshold tuning shows up as score distribution shifts under the same `version`. Treat threshold changes as a separate axis from policy-text changes when interpreting the data.

**Label retirement** is the degenerate case: stop including the label in `workflow.metadata.labels` and the rows stop coming in. Existing audit data stays around for retrospective analysis.

---

## The two scanners

We operate two independent scanner pipelines. They share **no code** today and store results in different tables.

### 1. XGuard text moderation (YuFeng XGuard Reason 8B)

A classifier we run via vLLM as an OpenAI-compatible chat completion model in the orchestrator. It is **not** used conversationally — it's a per-label binary classifier.

**How it works** (logical, not code):

- One model call per label. The call includes the user content + one policy string for one label.
- `chatTemplateKwargs.policy` = wrapped policy, `reason_first = false`, `temperature = 0`, `topLogprobs = 20`, `maxTokens = 1` in prod.
- Only the first generated token matters: `x` = label applies / unsafe, `sec` = safe.
- Orchestrator computes a score from the first-token probability of `x` and compares to the label's threshold.
- Explanation generation is disabled in prod → **policy prompt quality has to make the first-token decision reliable on its own.**

**Two input modes:**

- **Prompt mode** — evaluates AI image generation prompts (structured text with fields)
- **Text mode** — evaluates site/user text (comments, messages, bios, model descriptions, support impersonation attempts)

**Per-label, per-call**: every label is a self-contained binary policy. The call shape includes the labels we want checked.

### 2. Image ingestion classifier

A pipeline of vision models the orchestrator runs over uploaded images. Returns per-image classification across multiple dimensions.

**`mediaRating` step output was expanded — not replaced.** The orchestrator request in [orchestrator.service.ts](src/server/services/orchestrator/orchestrator.service.ts) → `createImageIngestionRequest` now passes new input flags on the existing `mediaRating` step:

```ts
input: {
  mediaUrl: { $ref: '$arguments', path: 'mediaUrl' },
  engine: 'civitai',
  includeAgeClassification: true,
  includeAIRecognition: true,
  includeFaceRecognition: true,
  includeAnimeRecognition: true,
}
```

The `$type` discriminator is unchanged. The output schema gained four optional fields.

**Expanded `mediaRating.output` shape** (new fields are optional — old in-flight workflows return only `nsfwLevel`/`isBlocked`/`blockedReason?`):

```json
{
  "nsfwLevel": "x",
  "isBlocked": false,
  "ageClassification": {
    "detections": [{
      "boundingBox": {...},
      "ageLabel": "Teenager 13-20",
      "confidence": 0.653,
      "isMinor": false,
      "topK": { "Teenager 13-20": 0.653, "Adult 21-44": 0.252, ... }
    }]
  },
  "faceRecognition": { "faces": [{ "boundingBox": {...} }] },
  "aiRecognition":    { "label": "AI",    "confidence": 0.998 },
  "animeRecognition": { "label": "anime", "confidence": 0.992 }
}
```

Each new field becomes a **tag** on the image (full per-detection data goes to the audit log — see Proposed data layer):

- `nsfwLevel` value (e.g., `x`) → tag, already done today via `SpineRating` source
- `minor` → tag, source `MinorDetection`, when `ageClassification.detections.some(d => d.isMinor)`
- `ai` → tag, new source `AiRecognition`, when `aiRecognition.label === 'AI'`
- `anime` → tag, new source `AnimeRecognition`, when `animeRecognition.label === 'anime'`

The `topK` distributions, bounding boxes, face geometry, and confidences for non-triggered classifications go to the audit log raw — that's where prompt-tuning analysis pulls near-miss signal from. The flat tag rows are just the booleans.

**Video pipeline also gets the new fields.** The `repeat → mediaRating` block in `createImageIngestionRequest` for `type !== 'image'` passes the same `include*` flags as the image path. The repeater aggregator (`aggregateMediaRatingRepeater`) merges per-frame results: detections/faces are unioned across frames; `aiRecognition`/`animeRecognition` collapse to the per-frame result with the highest confidence.

`wdTagging` and `mediaHash` are unchanged.

**Code changes required in [image-scan-result.service.ts](src/server/services/image-scan-result.service.ts):**

1. Extend the `MediaRatingStep` TypeScript type (line 74) — add the four new optional output fields.
2. Extend `tagsWithSource` (line 251) to emit `minor`/`ai`/`anime` tags from the new fields when present.
3. Add `AiRecognition` + `AnimeRecognition` to the `TagSource` Prisma enum (or accept lossy provenance and reuse `Computed`).
4. Decide whether `auditScanResults` branches on the new `MinorDetection`-sourced `minor` tag (stronger signal than the hand-curated `tagsNeedingReview` list) or just appends `minor` to that list.
5. Forward the full untruncated `mediaRating.output` to the audit log so the per-detection / topK / non-triggered confidences are preserved for tuning.

---

## Glossary (terms get reused with different meanings — watch out)

| Term | Meaning |
| --- | --- |
| **Label** | An XGuard policy name. One label = one binary classifier call. E.g., `nsfw`, `csam`, `impersonation`. |
| **Policy** | The natural-language prompt text describing what makes the label apply (`x`) vs. not (`sec`). This is what we're trying to tune. |
| **Tag** | A token attached to an image after ingestion classification. Stored in `TagsOnImageDetails`. Different concept from XGuard "label" — but for this project we treat both as flat string keys per scan result. |
| **nsfwLevel** | On the `Image` table: numeric enum (`1=PG, 2=PG13, 4=R, 8=X, 16=XXX, 32=Blocked`). In the `mediaRating` output: a string (`"x"`, `"r"`, etc.). |
| **Source** | `TagSource` enum: `WD14`, `Clavata`, `Hive`, `SpineRating`, `MinorDetection`, `HiveDemographics`, `Computed`, `User`. Identifies which model/process produced a tag. |
| **Prompt mode / Text mode** | XGuard input modes (image-gen prompt vs. site text). |

---

## Where things live today

### XGuard text moderation

- **Caller**: [orchestrator.service.ts](src/server/services/orchestrator/orchestrator.service.ts) → `createTextModerationRequest`
- **Service wrapper**: [text-moderation.service.ts](src/server/services/text-moderation.service.ts) → `submitTextModeration` (hashes content for dedup, writes pending row)
- **Webhook**: [src/pages/api/webhooks/text-moderation-result.ts](src/pages/api/webhooks/text-moderation-result.ts)
- **Storage**: `EntityModeration` table ([prisma/schema.prisma](prisma/schema.prisma)) — fields: `entityType`, `entityId`, `workflowId`, `status`, `blocked`, `triggeredLabels[]`, `result` (slimmed JSON), `contentHash`
- **Slimming**: `slimTextModerationOutput` / `slimPromptModerationOutput` in [entity-moderation.service.ts](src/server/services/entity-moderation.service.ts) — drops internal fields, **keeps only triggered labels**. ⚠️ Lossy for tuning; we want non-triggered scores too to find near-misses. Slimming happens **in civitai**, not the orchestrator — so the webhook handler has access to the full payload before it's discarded.
- **Retry job**: [src/server/jobs/text-moderation-retry.ts](src/server/jobs/text-moderation-retry.ts)
- **Currently used by**: `Article` entity type only.

### Image ingestion

- **Webhook**: [src/pages/api/webhooks/image-scan-result.ts](src/pages/api/webhooks/image-scan-result.ts) — handles legacy POST + new orchestrator workflow format
- **Processor**: [image-scan-result.service.ts](src/server/services/image-scan-result.service.ts) → `processImageScanWorkflow` — parses `wdTagging`/`mediaRating`/`mediaHash` steps. The `mediaRating` type definition is what needs to be extended for the new fields.
- **Storage**:
  - `Image` table: `nsfwLevel: Int`, `minor: Boolean`, `poi: Boolean`, `needsReview: String?`, `blockedFor: String?`, `ingestion: ImageIngestionStatus`, `scanJobs: Json?`
  - `TagsOnImageDetails`: `automated`, `disabled`, `needsReview`, `confidence`, `source: TagSource`
  - `ImageTagForReview`: review queue (per-image, per-tag)
- **Review trigger conditions** (current logic in [image-scan-result.ts](src/pages/api/webhooks/image-scan-result.ts:697-733)): `child-10/13/15` + realistic, POI word-list match, `nsfwLevel === Blocked`, moderator-specific tags.
- **Tag rules**: [src/server/utils/tag-rules.ts](src/server/utils/tag-rules.ts) — replacements, appends, computed combos.

### Cross-cutting

- **Moderation word blocklists**: loaded from Redis `ENTITY_MODERATION` cache via [moderation-utils.ts](src/server/utils/moderation-utils.ts).
- **Moderation rules** (Approve/Block/Hold): `ModerationRule` Prisma model + [src/server/utils/mod-rules.ts](src/server/utils/mod-rules.ts).
- **Existing moderator review surfaces**: [src/pages/moderator/images.tsx](src/pages/moderator/images.tsx), [image-rating-review.tsx](src/pages/moderator/image-rating-review.tsx), [prompt-audit-test.tsx](src/pages/moderator/prompt-audit-test.tsx). New tuning-review UI will also live under `/moderator/*`.
- **ClickHouse**: [src/server/clickhouse/client.ts](src/server/clickhouse/client.ts) `Tracker` class — currently used for analytics events. We'll add a `scanner_label_results` table here for per-label scan score indexing (not raw outputs — those stay in the orchestrator and snapshot to Postgres on review).

---

## What's missing for prompt tuning

The current storage is optimized for **acting on** scanner results (block, hold, tag the image), not for **studying** them to tune the scanners. Specifically:

1. **No raw input record.** `EntityModeration` stores content hashes, not the content itself. For image ingestion, the original orchestrator response isn't preserved verbatim — it's normalized into tag rows and discarded.
2. **Slimmed/lossy output.** `slimTextModerationOutput` discards non-triggered label details. We can't see which labels almost-fired (near-misses), which is critical for finding false negatives and threshold tuning.
3. **No false-positive feedback loop.** `ImageTagForReview` exists for image tags but there's no analogous structure for "moderator says this XGuard label was wrong" or "this whole ingestion classification was a false positive."
4. **No per-policy versioning.** When we change a policy, we have no way to compare results before/after. Need a `version` (or hash of the policy string) recorded with each scan.
5. **Hard to slice for AI analysis.** Mixed across `EntityModeration.result` JSON blobs, `TagsOnImageDetails` rows, and `Image` flags. No single table where each row = one scanner decision an AI can chew on.

---

## XGuard policy ownership

XGuard policies (text + threshold + action per label) live orchestrator-side. Civitai just sends the workflow request specifying which `labels` to evaluate; the orchestrator runs them against its own configured policies and returns one result per label.

Per-label results include a `policyHash` field on the orchestrator response — a stable identifier for the exact policy text the orchestrator used at evaluation time. The audit writer reads it directly from each result and stores it as the per-label `version` column on `scanner_label_results`, so A/B comparisons across policy revisions work without any civitai-side bookkeeping.

For image scans (`mediaRating`), the orchestrator doesn't yet return per-result version info; the writer hardcodes `version: '1'` as a placeholder until the orchestrator team adds it.

The workflow-level **`modelVersion`** column tracks the version of the scanner/model itself (different concept from the per-label `version`). Stamped from `workflow.metadata.version` (hardcoded `'1'` for now, bumped when the underlying scanner model changes).

---

## Proposed data layer — ClickHouse + Postgres

**Dedup-first design.** At the projected volume (every prompt scanned, plus comments/messages), users iterating on the same prompt 50× produces 50 identical scan results that add no tuning signal. The audit log dedupes at the storage layer so storage and the mod queue both stay bounded by *distinct decisions*, not *raw event volume*.

**Split by access pattern:**

- **Orchestrator API** — source of truth for raw scanner outputs. 30-day TTL.
- **ClickHouse `scanner_label_results`** — `AggregatingMergeTree` keyed by `(scanner, label, contentHash, version)`. One logical row per *decision the model made about this content under this policy*. Duplicate inserts merge in the background; queries do `GROUP BY` to see the merged view.
- **Postgres `ScannerLabelReview`** — moderator verdicts, keyed by `(contentHash, version, label, reviewedBy)`. Verdicting once covers all future identical scans.

We do **not** store raw scanner outputs in ClickHouse — orchestrator covers that for 30 days; long-term retention of raw scan inputs/outputs is out of scope for the current design.

### ClickHouse: `scanner_label_results` — one row per unique decision

```sql
CREATE TABLE scanner_label_results (
  contentHash     String,
  version         String,                    -- per-label: policyHash (XGuard) or '1' (image, placeholder)
  label           LowCardinality(String),
  scanner         LowCardinality(String),    -- 'image_ingestion' | 'xguard_text' | 'xguard_prompt'
  entityType      LowCardinality(String),    -- 'image' | 'Article' | 'prompt' | ...
  labelValue      LowCardinality(String),    -- multi-class value (e.g. 'x' for nsfw_level); empty for binary
  modelVersion    LowCardinality(String),    -- workflow-level scanner version, from workflow.metadata.version

  -- Stable per merge key (or "latest wins"):
  score           SimpleAggregateFunction(anyLast, Float32),
  threshold       SimpleAggregateFunction(anyLast, Nullable(Float32)),
  triggered       SimpleAggregateFunction(max, UInt8),
  -- modelReason intentionally NOT stored here. It lived on this table
  -- originally but observations of truncation pushed us to resolve it lazily
  -- from the workflow in scanner-content.service. Snapshots persist it past
  -- the orchestrator's 30-day TTL.
  matchedText     SimpleAggregateFunction(anyLast, Array(String)),
  matchedPositivePrompt SimpleAggregateFunction(anyLast, Array(String)),
  matchedNegativePrompt SimpleAggregateFunction(anyLast, Array(String)),
  durationMs      SimpleAggregateFunction(anyLast, UInt32),

  -- Accumulating across duplicate inserts:
  firstSeenAt     SimpleAggregateFunction(min, DateTime),
  lastSeenAt      SimpleAggregateFunction(max, DateTime),
  occurrences     SimpleAggregateFunction(sum, UInt64),
  workflowIds     SimpleAggregateFunction(groupUniqArrayArray, Array(String)),
  entityIds       SimpleAggregateFunction(groupUniqArrayArray, Array(String))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(lastSeenAt)
ORDER BY (scanner, label, contentHash, version);
```

**Write semantics.** Each insert sets `occurrences = 1`, `firstSeenAt = lastSeenAt = completedAt`, `workflowIds = [workflowId]`. ClickHouse background-merges duplicate inserts on the merge key; merged rows have `occurrences` summed, `workflowIds` union-deduped, etc.

**Read semantics.** All queue queries `GROUP BY (contentHash, version, label)` with the matching aggregate functions. **Always include a `WHERE lastSeenAt > now() - INTERVAL N DAY` predicate** so the planner skips old partitions — this is the main scaling lever. Default lookback is 30 days; queries that span longer windows touch more partitions.

**Two ClickHouse quirks to know:**

1. **Aliases shadow columns in WHERE.** A query like `SELECT max(lastSeenAt) AS lastSeenAt ... WHERE lastSeenAt > now() - INTERVAL N DAY` errors with `Aggregate function found in WHERE` because the WHERE reference resolves to the SELECT alias instead of the raw column. Every query in `scanner-review.service.ts` appends `SETTINGS prefer_column_name_to_alias = 1` to restore standard-SQL semantics (column wins over alias) so partition pruning on `lastSeenAt` works.
2. **With the setting on, HAVING + ORDER BY need the explicit aggregate, not the alias.** `HAVING triggered = 1` resolves to the raw column post-GROUP-BY, which silently matches nothing (no error, just empty results). Write `HAVING max(triggered) = 1` instead. Same for `ORDER BY anyLast(score) DESC` rather than `ORDER BY score DESC`. SELECT aliases are still fine — the consumer types still see clean field names.

```sql
-- Mod queue: latest triggered decisions for label 'csam' (last 30 days)
SELECT
  contentHash, version, label,
  anyLast(score) AS score, anyLast(threshold) AS threshold,
  max(triggered) AS triggered, sum(occurrences) AS occurrences,
  max(lastSeenAt) AS lastSeenAt,
  groupUniqArrayArray(workflowIds) AS workflowIds
FROM scanner_label_results
WHERE lastSeenAt > now() - INTERVAL 30 DAY
  AND scanner = 'xguard_text'
  AND label = 'csam'
GROUP BY contentHash, version, label
HAVING triggered = 1
ORDER BY lastSeenAt DESC
LIMIT 50;

-- Latency p50/p95 (no DISTINCT needed — each merge-key row has one
-- representative duration):
SELECT scanner,
       quantile(0.5)(durationMs) AS p50,
       quantile(0.95)(durationMs) AS p95
FROM (
  SELECT any(scanner) AS scanner, anyLast(durationMs) AS durationMs
  FROM scanner_label_results
  WHERE lastSeenAt > now() - INTERVAL 7 DAY
  GROUP BY contentHash, version, label
)
GROUP BY scanner;
```

**Subtle but aligned-with-needs:** because merges happen *within* partitions, `occurrences` reflects the window queried, not lifetime. "This prompt has shown up 50 times in the last 7 days" is what mods and tuning analysis actually want; lifetime counts would require wider windows that touch more partitions.

### Write paths

The writer ([scanner-audit.service.ts](src/server/services/scanner-audit.service.ts)) computes `contentHash` per scan input and emits one row per label. Every insert is treated as one occurrence of a decision; the AggregatingMergeTree engine collapses duplicates in the background.

- **Image ingestion** (`mediaRating` step) — `contentHash = sha256("image:" + imageId)` so rescans of the same image collapse. Emits up to 5 rows per scan: `nsfw_level` (always), `is_blocked` (always), `minor` / `ai` / `anime` (when the corresponding classifier was included in the step).
- **XGuard text/prompt** — `contentHash = sha256(textOrPositiveAndNegative)` so identical prompts/text collapse across users. Emits one row per label evaluated. Called from [text-moderation-result.ts](src/pages/api/webhooks/text-moderation-result.ts) before the slimmer runs, so non-triggered scores are captured.

Both writes are fire-and-forget — a ClickHouse failure logs to Axiom but never blocks the operational webhook.

### Postgres: `ScannerLabelReview` — moderator verdicts

```prisma
enum ReviewVerdict {
  TruePositive
  FalsePositive
  TrueNegative
  FalseNegative
  Unsure
}

model ScannerLabelReview {
  id          Int           @id @default(autoincrement())
  contentHash String
  version     String
  label       String
  reviewedBy  Int           // userId of moderator
  reviewedAt  DateTime      @default(now())
  verdict     ReviewVerdict
  note        String?

  @@unique([contentHash, version, label, reviewedBy])
  @@index([verdict, label])
  @@index([reviewedAt])
}
```

A mod verdicting a `(contentHash, version, label)` once covers all future identical scans — that's the efficiency gain of the deduped storage layer. Multi-mod review is supported via the unique constraint including `reviewedBy`; disagreements surface in the detail drawer as "verdicts: TP × 1, FP × 2".

**`unsure`** is a valid verdict but must be excluded from FP/FN rate denominators in analysis queries (it inflates uncertainty rather than indicating ground truth).

### Service interface

All writes to ClickHouse + Postgres go through a single `scanner-audit.service.ts`. Webhook handlers call it; nothing else does. Keeps the boundary clean for a future extraction to a standalone service.

---

## Open questions

- **Retention.** Raw scanner inputs (especially full image-gen prompts) can be sensitive. Do we PII-scrub before storing, or partition by retention class? Deferred until more sensitive entity types opt in to `recordForReview`.
- **TTL on `scanner_label_results`.** The AggregatingMergeTree table will grow unbounded without one. A `TTL lastSeenAt + INTERVAL 1 YEAR DELETE` clause would cap storage cheaply. Defer until volume actually justifies it.
- **`tagsNeedingReview` interaction.** New `minor` tag from `MinorDetection` source is a stronger signal than the hand-curated list. Should the audit logic branch on source, or just append `minor` to the list? (Operational image-tagging concern, separate from the audit project.)
- **Pre-call Redis dedup for orchestrator-cost savings.** AggregatingMergeTree handles the storage side; layering a short-TTL Redis pre-call check could additionally save orchestrator $ on burst-mode iteration. Optional add-on if/when scan volume makes orchestrator cost meaningful.
