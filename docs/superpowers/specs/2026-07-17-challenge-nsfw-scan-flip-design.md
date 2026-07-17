# Challenge NSFW text-scan escalation & green→yellow flip

**Date:** 2026-07-17
**Status:** Approved (design)

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

- Raise its rating to **R** (if currently below R) so it drops out of safe-mode feeds.
- If it's a **green** challenge, **flip it to yellow** so the domain-currency gate moves it off
  civitai.com and onto civitai.red.
- Keep the pool currency consistent with `buzzType` (never pay winners in a currency that was never collected).

## Non-goals

- No global XGuard threshold changes (would affect article/other text scans).
- No new "add a prize during edit" path (edit still can't change the pool).
- No handling of entry-fee escrow at flip time — none exists yet (see timing below).

## Key facts (verified)

- `green` and `yellow` are **distinct buzz wallets** (`buzz.constants.ts:92-101`), separate balances.
  Flipping `buzzType` therefore requires migrating pool currency, not just relabeling.
- **Timing:** the scan callback (`applyResult`) is what sets `ingestion=Scanned`, and a user challenge is
  hidden until Scanned; entries require Active + visible. So at flip time the challenge is always
  **Scheduled with no entries** — the only escrow is the creator's optional initial prize, charged in green.
- `NsfwLevel.R = 4`; `allowedNsfwLevel` is a bitwise browsing-level mask; `deriveChallengeNsfwLevel =
  Flags.maxValue(allowedNsfwLevel)`.
- The create-time guard `isNonSfwForGreen` blocks a green challenge with a non-SFW *declared*
  `allowedNsfwLevel`, so a green challenge is always SFW-declared at scan time — the flip always raises
  from an SFW level.

## Design

### A. Detection

`scanUserChallenge` and `challengeModerationAdapter.submit` request labels **`['nsfw','suggestive','explicit']`**.
The adapter's `isNsfw` becomes `triggeredLabels.length > 0` (any of the three) rather than an nsfw-only check.

Rationale: evidence-based, challenge-scoped (article scans keep their own label set), large trigger margin.

### B. Escalation — `challengeModerationAdapter.applyResult`

Extract the escalation into a focused, unit-testable helper (e.g. `applyChallengeNsfwEscalation`) so the
adapter stays thin. On `isNsfw && !blocked`:

**All user challenges**
1. `newAllowed = Flags.addFlag(allowedNsfwLevel, NsfwLevel.R)` (PG|PG13 → PG|PG13|R). No-op if already ≥ R.
2. `nsfwLevel = deriveChallengeNsfwLevel(newAllowed)` (= R).
3. Update the challenge's collection `metadata.forcedBrowsingLevel = newAllowed` so entry gating matches.

**Only `source === 'User'` && `buzzType === 'green'` (the flip)**
4. Set `buzzType = 'yellow'`. The domain-currency gate now hides it from civitai.com and shows it on civitai.red.
5. Refund the green initial prize and zero the pool:
   - `refundMultiAccountTransaction({ externalTransactionIdPrefix: 'challenge-initial-prize-${id}-creator-green' })`
     — reverses the original green charge back to the creator (mint-safe).
   - Set `basePrizePool = 0`, `prizePool = 0`. The challenge continues entry-fee-funded (in yellow) if it has an entry fee.
6. Notify the creator (`system-message`, key `challenge-nsfw-flipped-${id}`): rating raised to R, moved to the
   adult site, and — if a prize existed — the green initial prize was refunded.

The clean path and the `blocked` path are unchanged.

**Idempotency:** the flip (steps 4–6) is gated on `buzzType === 'green'`. A retry callback runs after the row is
already `yellow`, so it skips the flip and the refund. `addFlag`, the pool-zeroing, and the notification key are all
idempotent.

**Yellow challenge + NSFW:** steps 1–3 only (already off-green; no flip, no refund).

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

- Unit-test `applyChallengeNsfwEscalation` (the extracted helper) for: green flip (rating raised, buzzType→yellow,
  pool zeroed, refund invoked, notification), yellow no-flip (rating raised, no buzzType change, no refund),
  already-≥R no-op, idempotent second run on an already-yellow row.
- Extend the existing scan/adapter tests (`challenge-edit-rescan.service.test.ts`, `challenge-review.service.test.ts`)
  as needed for the new label set / trigger semantics.

## Rollout

- Code-only. No schema change. No manual DB migration.
- Challenge 406 can be re-scanned (edit its text or force a rescan) to verify end-to-end after deploy.
