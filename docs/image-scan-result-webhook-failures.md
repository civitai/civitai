# Image scan result webhook — failure triage (2026-07-31)

Investigation of errors logged by the `/api/webhooks/image-scan-result` handler and
`processImageScanResult` (`src/server/services/image-scan-result.service.ts`), which became the
default scan-result path on 2026-07-22.

## Where failures are logged

| Signal | Dataset | Shape |
| --- | --- | --- |
| `processImageScanResult` throws | `civitai-prod` | `name: 'image-scan-result'`, `type: 'error'` — from the catch in `src/pages/api/webhooks/image-scan-result.ts` |
| Workflow reached a non-success terminal state | `webhooks` | `name: 'image-scan-result'`, `type: 'warning'` — `logToAxiom(..., 'webhooks')` |

The cutover dropped total errors from ~4.5k/day (legacy `Image not found`) to ~200-600/day.

## Error classes seen after the cutover

| # | Message | Volume | Status |
| --- | --- | --- | --- |
| 1 | `Cannot read properties of undefined (reading '$type')` | 80-180/day | Crash fixed; see caveat |
| 2 | `ClickHouse query failed: socket hang up` (blocked_images pHash) | 30-120/day | Proposed below |
| 3 | `invalid media rating for workflow: <id>` | 14-56/day | Open — see notes |
| 4 | Signal send failures (timeout / 500 / circuit open) | 90-500/day | Proposed below |

@dev - probably need to do backoff retries

@ai: Agreed — the ClickHouse call has no retry today. `$query` in
`packages/civitai-clickhouse/src/client.ts` just wraps the driver error and rethrows, so a
`socket hang up` fails on the first attempt. Retry design folded into the item 2 fix below.

---

## Item 2 — ClickHouse pHash check fails the whole webhook

### Problem

`logPerceptualHashMatch` is diagnostic only. Its own call site says so:

```js
// Log (don't act on) perceptual-hash matches against known-blocked content.
if (!mediaRating.isBlocked && pHash) await logPerceptualHashMatch({ imageId, pHash });
```

Nothing branches on the result. But a ClickHouse `socket hang up` propagates out of
`processImageScanWorkflow`, 400s the webhook, and discards a scan that had already produced
valid tags and a rating. The image stays `Pending`.

### Why swallowing is safe here

`getIsImageBlocked` has exactly one caller — `logPerceptualHashMatch`. No moderation decision
reads it, so there is no fail-open risk.

### Fix — item 2

Two layers: retry the transient failure, then swallow whatever still fails.

**1. Retry the query.** `socket hang up` is a dropped connection, which is exactly what a retry
recovers. There is no retry anywhere on this path today — `$query`
(`packages/civitai-clickhouse/src/client.ts`) only wraps the driver error:

```js
try {
  const response = await client.query({ query, format: 'JSONEachRow' });
  return await response?.json<T>();
} catch (e) {
  throw new Error(`ClickHouse query failed: ${(e as Error).message}\nQuery: ${query}`);
}
```

Wrap the call with the existing `withRetries` helper (`~/utils/errorHandling`):

```js
async function getIsImageBlocked(hash: bigint) {
  if (!env.BLOCKED_IMAGE_HASH_CHECK || !clickhouse) return false;

  const rows = await withRetries(
    () => clickhouse!.$query<{ count: number }>`
      SELECT cast(count() as int) as count
      FROM blocked_images
      WHERE bitCount(bitXor(hash, ${hash})) < 5 AND disabled = false
    `,
    2,   // 3 attempts total
    250  // ms between attempts
  );

  return (rows?.[0]?.count ?? 0) > 0;
}
```

Caveats worth knowing before picking numbers:

- `withRetries` uses a **fixed** delay, not exponential — it re-invokes with the same
  `retryTimeout` each time. For a dropped socket to an internal service that is fine; if we want
  genuinely exponential backoff, `withRetries` needs changing (it passes `remainingAttempts` to
  the callback but applies the sleep itself, so the delay can't vary per attempt today).
- It retries **every** error, including a malformed query. Harmless here (3 fast failures) but it
  means the retry count is not free if the query itself ever breaks.
- This sits in the webhook request path, so the worst case adds ~500ms to a failing scan callback.
  At 30-120 failures/day that is negligible, but it is not zero.

**2. Keep the catch as a backstop.** Retries reduce the failure rate; they don't eliminate it (a
full ClickHouse outage still exhausts them). Since nothing branches on this result, the final
failure must not fail the webhook:

```js
async function logPerceptualHashMatch({ imageId, pHash }: { imageId: number; pHash: bigint }) {
  const pHashBlocked = await getIsImageBlocked(pHash).catch((error) => {
    logToAxiom(
      {
        name: 'image-phash-match',
        type: 'warning',
        message: 'pHash blocklist check failed',
        imageId,
        error: error.message,
      },
      'webhooks'
    ).catch(() => null);
    return false;
  });
  if (!pHashBlocked) return;
  // ...
}
```

Keep the catch at this call site, **not** inside `getIsImageBlocked` — a future caller that acts
on the result should fail closed rather than inherit a silent `false`.

The `rows?.[0]?.count ?? 0` above also fixes a second, rarer failure: the original
`const [{ count }] = await clickhouse.$query...` throws on an empty result set.

---

## Item 4 — a failed UI signal fails the whole webhook

### Problem

All three messages originate in `signalClient.send` (`src/utils/signal-client.ts`):

- `AbortSignal.timeout(5000)` → `TimeoutError: The operation was aborted due to timeout`
- non-2xx → `failed to send signal: image-ingestion:status. Expected 200, got 500`
- `withSignals` breaker → `Signals circuit open — failing fast`

The call sits at the **end** of `processImageScanWorkflow`, after every DB write and
`applyIngestionSideEffects` have committed:

```js
await applyIngestionSideEffects({ image, outcome });
await signalClient.send({ target: SignalMessages.ImageIngestionStatus, ... });
```

So a signals brownout 400s a webhook whose work is already done, and the orchestrator retries the
entire callback. Those side effects are mostly cache busts and search-index queues, so the cost is
wasted work rather than corruption — but it is a full re-run of a completed ingestion because a UI
push didn't land.

Attribution note: the stacks are pure undici with no app frames, so this is inferred from the
message strings and the fact that the 5s abort is the only one on this path.

### Fix — item 4

```js
await signalClient
  .send({
    target: SignalMessages.ImageIngestionStatus,
    data: { imageId: image.id, ingestion: outcome.ingestion, blockedFor: outcome.blockedFor },
    userId: image.userId,
  })
  .catch((error) =>
    logToAxiom(
      {
        name: 'image-scan-result',
        type: 'warning',
        message: `signal send failed: ${error.message}`,
        imageId: image.id,
      },
      'webhooks'
    ).catch(() => null)
  );
```

This is already the house pattern — `src/server/services/referral.service.ts` and
`src/server/auth/session-invalidation.ts` both catch-and-log around `signalClient.send`.

Apply the same change to the legacy path at `src/pages/api/webhooks/image-scan-result.ts` (the
unguarded `await signalClient.send` in the `data.ingestion !== 'Blocked'` branch) — that call is
why timeout/signal-500 errors also appear on days before the 07-22 cutover.

### Tradeoff

Demoting to a warning means the uploader's UI won't update until they refresh. That is already
what happens today (the signal genuinely failed); the only change is that we stop throwing away
the scan as well. Confirm nothing downstream treats this signal as delivery-guaranteed.

---

## Expected effect

Items 2 and 4 are ~120-600/day combined — after item 1, essentially all remaining error volume.
Both convert from `error` + HTTP 400 to `warning` + HTTP 200. The counts don't disappear, they
move to a severity that no longer strands images.

---

## Retry behaviour when these failures happen (items 1 and 3)

Both item 1 and item 3 throw inside `parseScanSteps`, which runs **before**
`removeImageScanJobQueue([image.id])`. So the `JobQueue` row survives and the image stays
`ingestion = 'Pending'` with its original `scanRequestedAt`.

In principle `ingest-images` (`src/server/jobs/image-ingestion.ts`, every 5 min) re-drives it:

1. `pendingImages` — `ingestion = 'Pending'` and `scanRequestedAt <= now - IMAGE_SCANNING_RETRY_DELAY`
   (50 min in prod). **This path has no retry cap**, unlike the Rescan and Error paths.
2. Age-out — a non-backfill image whose immutable `createdAt` is older than
   `IMAGE_SCANNING_PENDING_TIMEOUT` (default 60 min) is flipped to `Error`.
3. Error retries — hourly, capped by `getImageScanRetryLimit(failureClass)`. Items 1 and 3 throw
   before any `failureClass` is stamped, so they get the `Unknown` cap of 9.

Each re-send mints a **new** workflow ID and overwrites `scanJobs.workflowId`, so the stored ID is
the most recent attempt, not necessarily the one that produced a given logged error.

### In practice this does not happen — the queue head is permanently stuck

Measured 2026-07-31. `JobQueue` depth for `ImageScan` is **83,064**, oldest entry 2026-07-22.
`IMAGE_SCANNING_MAX_PER_RUN` is 1000, pulled `ORDER BY createdAt ASC`.

The blocker is **not** the retry cooldown — only 80 of 83k rows were in cooldown at measurement
time. Nearly everything is eligible:

| Bucket | Rows |
| --- | --- |
| `Error`, past cooldown | 62,839 |
| `Pending`/`Rescan`, past cooldown | 6,198 |
| Image row missing (prunable) | 11,664 |
| Terminal status (prunable) | 2,224 |
| In cooldown | 80 |

The actual cause is in `ingestImage` (`src/server/services/image.service.ts`). When the
orchestrator submit returns no workflow, it logs and does a bare `return false` **without touching
the Image row**:

- `scanRequestedAt` is not stamped → the row is always past its cooldown → always "eligible"
- `retryCount` is not incremented → it never reaches a retry ceiling → never classified stale →
  never pruned

So a row whose submit fails deterministically is re-attempted every 5 minutes forever and can
never leave the queue. ~62k of these sit at the head and consume the entire per-run budget, so
genuinely new failures — tens of thousands of positions back — are never reached.

### Why the submits fail

Axiom, `name: 'image-ingestion'`, 6-hour window:

| Orchestrator response | Count |
| --- | --- |
| 400 `Input image is too large.` | 14,630 |
| 400 `Input image failed to download from URL.` | 74 |
| 500 (retried 3×, then given up) | 24 |

The 400s come back on `attempts: 1` — `submitWorkflowWithRetry` correctly treats them as
non-retryable. These images exceed the orchestrator's input size limit and will never scan at
their current size.

### Item 1 caveat — the crash is fixed, the failure is not

The optional chaining stops the `TypeError`, but a zero-frame video still ends as
`Incomplete workflow: <id>` → HTTP 400 → image stays `Pending`. Axiom volume does not drop;
the signature re-labels. The message now carries the `workflowId`, which the `TypeError` did
not, so the failures become attributable.

To actually retire the alert, zero-frame extraction needs to route through `markImageScanError`
with a permanent-ish `failureClass` so the row is stamped and the capped-retry machinery
terminalizes it — the same shape as the submit-failure fix below. Not done yet.

Aggregation over a repeat now requires **every** frame sub-step to have an `output`. `output` is
optional on every orchestrator step (`@civitai/client` `types.gen.d.ts`), while the local types
in `image-scan-result.service.ts` declare it required — so TS offers no protection here. Because
`nsfwLevel` aggregates as a max and `isBlocked` as an OR, skipping a frame can only ever
*under-rate* a video; a partial set is therefore treated as no result rather than aggregated.

### Fix — queue drain

1. `markImageScanSubmitFailure` in `image.service.ts` — on a failed submit, stamp
   `scanRequestedAt`, increment `retryCount`, and store
   `scanJobs.error.{failureClass, reason, responseStatus}`.
2. `'image is too large'` added to `PERMANENT_REASON_PATTERNS` in `image-scan-failure.ts`, so the
   dominant failure classifies as `Permanent` (ceiling 1) rather than `Unknown` (ceiling 9).

Three constraints found in review, each of which the naive version got wrong:

- **Only a `Permanent` failure flips `ingestion` to `Error`.** The Error lane runs hourly *and*
  with `lowPriority: true` (`image-ingestion.ts:365`), so flipping on a transient 5xx would demote
  a fresh upload behind the article backfill for an hour over a two-minute blip. Transient and
  Unknown keep their status; stamping `scanRequestedAt` + `retryCount` alone is enough to break
  the every-5-minutes loop, and the `createdAt` age-out still terminalizes anything that never
  returns.
- **Only 400/415/422 are permanent by status** (`PERMANENT_SUBMIT_STATUSES`). Treating any 4xx as
  permanent would include 401/403/404 — so an expired orchestrator token would mark every
  submitted image terminally `Error` and prune it from the queue within hours, unrecoverable
  without manual SQL. 413 is excluded too: it can equally mean *our* request body outgrew a
  limit, and prod returns the image-size rejection as a 400 anyway. Anything omitted falls
  through to a bounded retry, so an omission costs retries while a wrong entry costs the image.
- **The UPDATE is guarded by `ingestion IN ('Pending','Rescan','Error')`.** Without it, a
  moderator rescan (`image.router.ts:154` → `ingestImageById`) of a published `Scanned` image
  that gets a 400 would flip it to terminal `Error` and drop it out of every feed. The same guard
  covers the race where submit retries (3 × ~15s) outlive a callback that already wrote a verdict.

No new cleanup job is needed. `IMAGE_SCAN_PERMANENT_RETRY_LIMIT` is 1, so each stuck row gets one
more submit attempt, is terminalized, and is pruned as stale on the following pass. The backlog
drains itself through the existing capped-retry machinery at 1000 rows/run.

This also does not increase scanner load: those submits already happen on every run today: the
only change is that they stop repeating forever.

### Residual risk

Images rejected as "too large" end up terminally `Error` and unscanned. That is the honest state
(they cannot be scanned as-is), but if they should be scannable, the real fix is upstream —
downscaling before submit, or raising the orchestrator's limit. Worth a follow-up decision.

`markImageScanSubmitFailure` duplicates the jsonb shape written by `markImageScanError` in
`image-scan-result.service.ts`. They differ (submit failures have no `workflowId`), but the two
should probably share a helper before a third caller appears.
