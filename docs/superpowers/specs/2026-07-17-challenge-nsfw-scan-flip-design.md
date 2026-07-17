# Challenge NSFW text-scan escalation & green-challenge cancel

**Date:** 2026-07-17
**Status:** Approved (design)

> Earlier drafts of this spec flipped a green NSFW challenge to yellow; the final design **cancels** it
> (void + refund) instead. See the "Design note (why cancel, not flip)" under Goal. The file slug retains
> `-flip` for link stability.

## Problem

A user challenge whose NSFW content lives only in its **text** (theme/title/description/invitation)
can slip onto the safe site. Challenge 406 (`theme: "Sexy Cum"`, declared SFW, `buzzType: green`)
was scanned and returned "clean": it stayed `nsfwLevel` PG13, `buzzType` green, and would surface on
civitai.com.

Two independent causes:

1. **Detection miss.** `scanUserChallenge` requests only the `nsfw` label (threshold 0.75). On the 406
   text the model scored **0.6786 — below threshold**, so nothing triggered. Empirically the same text
   scores **Suggestive 0.9158** and **Explicit 0.8943** (both threshold 0.5) — either would have caught it
   with a large margin.

2. **No escalation.** Even had `nsfw` triggered, `challengeModerationAdapter.applyResult` only floors the
   display `nsfwLevel` to R. It never raises `allowedNsfwLevel`, never updates the collection's
   `forcedBrowsingLevel`, and never flips `buzzType`. A green challenge stays green — gated to the *safe*
   site by the domain-currency filter (`challenge.service.ts:429-437`) — even at `nsfwLevel` R.

## Goal

When a challenge's text scans as sexual content:

- If it's a **green** (safe-site) user challenge, **cancel it** (void → status Cancelled, close the
  collection, refund any initial prize) and notify the creator to recreate it on civitai.red. Green
  challenges must be SFW; NSFW text means the challenge shouldn't exist as a green challenge.
- If it's a **yellow** challenge (already on civitai.red), raise its rating to **R** (if currently below R)
  so it drops out of safe-mode feeds — it stays live.

> **Design note (why cancel, not flip):** an earlier iteration flipped a green challenge to yellow
> (buzzType flip + collection re-level + green-prize refund + pool-zeroing). Cancelling instead reuses the
> existing, race-safe `voidChallenge` primitive, eliminates a class of edge cases (currency consistency on a
> live flipped challenge, the pre-deploy refund-prefix bug, collection-update failure modes), and matches
> the create-time "green = SFW" invariant. The cost is UX: the creator recreates on civitai.red rather than
> having the challenge auto-moved. Accepted for this edge case.

## Non-goals

- No global XGuard threshold changes (would affect article/other text scans).
- No green→yellow currency migration / auto-move (superseded by cancel).

## Key facts (verified)

- **Timing:** the scan callback (`applyResult`) is what sets `ingestion=Scanned`, and a user challenge is
  hidden until Scanned; entries require Active + visible. So at scan time the challenge is always
  **Scheduled with no entries** — the only escrow is the creator's optional initial prize.
- `voidChallenge(id)` (`challenge.service.ts:2499`) is the cancel primitive: it atomically claims
  Scheduled→Cancelled *before* refunding (mint-safe against the completion cron), closes the collection, and
  calls `refundUserChallengeFunds` (refunds entry fees — none here — plus the initial prize via the broad
  `challenge-initial-prize-${id}-creator` prefix, matching pre-deploy and new charge ids). It is idempotent
  (a re-run lands on the Cancelled branch and re-refunds harmlessly).
- `NsfwLevel.R = 4`; `allowedNsfwLevel` is a bitwise browsing-level mask; `deriveChallengeNsfwLevel =
  Flags.maxValue(allowedNsfwLevel)`.
- The activation job already voids `Blocked` challenges (`challenge-activation.ts:33`), so voiding a
  green-NSFW challenge from the scan callback is the same terminal treatment, just immediate.

## Design

### A. Detection

`scanUserChallenge` and `challengeModerationAdapter.submit` request labels **`['nsfw']`** (shared
`CHALLENGE_MODERATION_LABELS`). The adapter's `isNsfw` is `triggeredLabels.length > 0`.

> **Interim:** only the `nsfw` label is currently reliable in XGuard, so we scan for it alone.
> `suggestive`/`explicit` (threshold 0.5) would catch borderline text like the 406 theme (nsfw scored
> 0.6786, below the 0.75 threshold) with a large margin — but they're not yet trustworthy, so for now only
> clearly-NSFW text (score ≥ 0.75) escalates. Re-add them, or apply a challenge-scoped threshold override,
> once they're reliable. The change is one const (`CHALLENGE_MODERATION_LABELS`); no escalation logic depends
> on which labels are requested.

### B. Escalation — `challengeModerationAdapter.applyResult`

A focused, unit-testable helper `applyChallengeNsfwEscalation({ entityId, isNsfw })` keeps the adapter thin.
A pure `computeNsfwEscalation(...)` decides the branch; the helper applies it. On the non-`blocked` path:

**Green user challenge + NSFW (`cancel`)** — `isNsfw && source === 'User' && buzzType === 'green'`:
1. `await voidChallenge(entityId)` — Cancelled + collection closed + initial prize refunded (idempotent).
   Void runs **first**: a crash before step 2 then leaves the challenge Cancelled (hidden), never a
   Scanned-and-therefore-*visible* green NSFW challenge (the scan gate reveals a challenge once Scanned).
2. Mark the scan resolved: `ingestion = Scanned`, `scannedAt = now` (moderation state coherent).
3. Notify the creator (`system-message`, key `challenge-nsfw-cancelled-${entityId}`): the challenge was
   cancelled because its text is adult content; any prize was refunded; recreate it on civitai.red.

**Yellow / non-user challenge + NSFW (raise, stays live):**
1. `newAllowed = Flags.addFlag(allowedNsfwLevel, NsfwLevel.R)` (no-op if already ≥ R);
   `nsfwLevel = deriveChallengeNsfwLevel(newAllowed)` (= R). Write both + `ingestion = Scanned`, `scannedAt = now`.
2. Update the collection `metadata.forcedBrowsingLevel = newAllowed` (via `updateMany`, so a deleted
   collection no-ops instead of throwing).
3. Notify the creator (key `challenge-nsfw-raised-${entityId}`) only when the level actually rose.

**Clean scan:** `ingestion = Scanned`, `scannedAt = now`, `nsfwLevel = deriveChallengeNsfwLevel(allowedNsfwLevel)`.
The `blocked` path is unchanged.

**Idempotency:** the cancel path is safe on a retried callback — `voidChallenge` self-dedups (Cancelled branch,
idempotent refund) and the notification key is deterministic. `buzzType` is never changed, so the `cancel`
decision stays stable across retries.

### C. externalTransactionId currency scoping — `challenge-funding.ts`

`chargeInitialPrize` (`:77`) currently uses `challenge-initial-prize-${challengeId}-creator`. A refund reverses the
charge into a *new* ledger entry and marks the original refunded; the original row **persists with its
`externalTransactionId`**, and `createBuzzTransaction` treats a duplicate id as an already-done no-op
(`buzz.service.ts:466`). So any future re-charge on the same id would be **silently dropped → unfunded pool**.

Fix: append the currency to the charge id → `challenge-initial-prize-${challengeId}-creator-${fromAccountType}`.

- Suffix (not infix) keeps every existing **prefix** match working: `refundUserChallengeFunds` (`:265`) still uses
  `challenge-initial-prize-${challengeId}-creator`, a valid prefix of both the old (`-creator`) and new
  (`-creator-green` / `-creator-yellow`) ids, and the 5-vs-50 collision-safety is preserved.
- **No prod migration:** existing rows keep their old id; the refund prefix matches them unchanged.

## Testing

- Unit-test the pure `computeNsfwEscalation` for: clean, green-user+nsfw → cancel, yellow+nsfw → raise (no
  cancel), non-user+nsfw → raise (no cancel), already-≥R no-op.
- Unit-test `applyChallengeNsfwEscalation` (mocked db / `voidChallenge` / notification) for: clean scan (Scanned,
  no void), green-user+nsfw (`voidChallenge` called BEFORE the Scanned write, cancelled-notification), yellow+nsfw
  (level raised, collection `updateMany`, raised-notification, `voidChallenge` NOT called), missing challenge no-op.
- The existing scan/adapter tests (`challenge-edit-rescan.service.test.ts`, `challenge-review.service.test.ts`)
  cover the new label set / trigger semantics.

## Rollout

- Code-only. No schema change. No manual DB migration.
- Challenge 406 can be re-scanned (edit its text or force a rescan) to verify end-to-end after deploy.
