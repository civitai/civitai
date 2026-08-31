import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import type { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import * as z from 'zod';

import {
  parseSubjectUserId,
  stashBlockActionDetail,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { createBuzzTipTransactionHandler } from '~/server/controllers/buzz.controller';
import { dbRead } from '~/server/db/client';
import { Tracker } from '~/server/clickhouse/client';
import type { ProtectedContext } from '~/server/createContext';
import { hydrateBlockSubject } from '~/server/services/blocks/block-collections.service';
import {
  BLOCK_TIP_CAP_PER_DAY,
  BLOCK_TIP_MAX_PER_TIP,
  checkBlockTipRateLimit,
  claimTipIdempotency,
  computeTipFingerprint,
  finalizeTipIdempotency,
  refundBlockTipSpend,
  releaseTipIdempotency,
  reserveBlockTipSpend,
} from '~/server/utils/block-tip-rate-limit';
import { BLOCK_IDEMPOTENCY_KEY_REGEX } from '~/server/utils/block-gen-idempotency';

/**
 * POST /api/v1/blocks/tip
 * Body `{ toUserId, amount, entityType?, entityId?, idempotencyKey? }` — scope
 * `social:tip:self`.
 *
 * Sends a Buzz TIP from the token SUBJECT to `toUserId`. Reuses the real
 * money-moving flow `createBuzzTipTransactionHandler` (NOT the low-level
 * `upsertBuzzTip`, which only records a row) so every hard gate the on-site tip
 * enforces applies here verbatim: self-tip reject, insufficient-balance,
 * banned/blocked target, 24h-account age, and the actual Buzz transaction +
 * notification. This endpoint self-binds the sender to the verified subject
 * (never a client-supplied fromUserId), adds a positive-int/sane-max amount
 * guard, a per-instance rate limit, and maps the handler's TRPCError to the
 * corresponding HTTP status (insufficient funds → a clean 400, never a 500).
 *
 * Response: `{ ok: true, tip: { toUserId, amount, entityType?, entityId? } }`.
 *
 * PAGE-SAFE via BOUNDED tipping: this endpoint enforces a per-tip cap
 * (BLOCK_TIP_MAX_PER_TIP) AND a per-user daily cap (BLOCK_TIP_CAP_PER_DAY,
 * reserve-and-refund) BEFORE any money moves — the analogue of the gen-spend
 * `buzzBudget` + `BLOCK_BUZZ_CAP_PER_DAY` pair. Those caps are what let
 * `social:tip:self` come off PAGE_FORBIDDEN_SCOPES (a page tip is now bounded, no
 * longer effectively-unbounded spend). Over either cap → clean 4xx (never a 500).
 *
 * IDEMPOTENCY (item 2, tip half): a tip is IRREVERSIBLE, so an OPTIONAL
 * client-generated `idempotencyKey` (stable across a lost-response / timeout
 * retry) collapses a replay to the FIRST terminal result — no second reserve, no
 * second charge. Absent key → today's behavior (no dedupe). The claim is fail-
 * CLOSED (a redis error at claim time → 503), consistent with the tip-cap posture.
 * The claim is scoped per (user, APP, key) and pinned to a PAYLOAD FINGERPRINT:
 *   - same key, same payload, first attempt live  → 409 (retry shortly)
 *   - same key, same payload, terminal result     → replay it verbatim
 *   - same key, DIFFERENT payload                 → 422 (mint a fresh key)
 * and a throw that escapes the money attempt RELEASES the claim rather than
 * stranding a 10-minute "already in progress" sentinel over nothing.
 *
 * Two layers back the dedupe. (1) The Redis sentinel above — fast path, 10-min TTL.
 * (2) The LEDGER: the key derives the tip's `externalTransactionId`, so a retry
 * after the sentinel expires collides on the Buzz ledger's unique constraint. That
 * second layer reports a CONFLICT, which this endpoint uses to refund the daily-cap
 * reservation it burned for Buzz that never moved (see `dedupedAmount` below).
 */

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

const bodySchema = z.object({
  toUserId: z.number().int().positive(),
  // Per-tip cap is the schema's hard upper bound — over-per-tip → clean 400.
  amount: z.number().int().positive().max(BLOCK_TIP_MAX_PER_TIP),
  entityType: z.enum(['Image', 'Collection', 'User']).optional(),
  entityId: z.number().int().positive().optional(),
  // OPTIONAL client idempotency key — a stable id the block reuses across its own
  // retry of the SAME logical tip. Absent → no dedupe (today's behavior). Charset-
  // restricted to a UUID-ish alphabet (audit 🟢) so no control chars / newlines /
  // colons flow into the ledger `externalTransactionId` derived from it, and length
  // bounded so it can't bloat the redis key; the block SDK generates a
  // `crypto.randomUUID` (or `idem-<base36>` fallback), both of which match.
  idempotencyKey: z.string().regex(BLOCK_IDEMPOTENCY_KEY_REGEX).optional(),
});

/** A terminal HTTP outcome from the tip attempt. `transient` outcomes (429/503) are
 *  NOT cached under the idempotency key — a genuine retry may re-execute them. */
type TipOutcome = { status: number; body: unknown; transient?: boolean };

// Exported for unit testing (the default export is wrapped in withBlockScope,
// whose JWT gate would otherwise have to be satisfied to reach this handler).
export const baseHandler = withAxiom(async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  let subjectUserId: number | null;
  try {
    subjectUserId = parseSubjectUserId(claims.sub);
  } catch {
    res.status(403).json({ error: 'Invalid subject claim' });
    return;
  }
  if (subjectUserId == null) {
    res.status(403).json({ error: 'Anonymous block tokens may not tip' });
    return;
  }

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }
  const { toUserId, amount, entityType, entityId, idempotencyKey } = parsed.data;

  // entityType/entityId must be supplied together (both or neither).
  if ((entityType && !entityId) || (!entityType && entityId)) {
    res.status(400).json({ error: 'entityType and entityId must be provided together' });
    return;
  }

  // Self-tip guard (the handler also rejects this — belt + suspenders + a clean
  // message before any DB work).
  if (toUserId === subjectUserId) {
    res.status(400).json({ error: 'You cannot tip yourself' });
    return;
  }

  // RECIPIENT existence/tippable check — the shared handler only checks the target
  // is not banned, NOT that it exists, so without this a page app could try to
  // credit Buzz into a non-existent (or soft-deleted) account id. Reject a
  // missing/deleted recipient with a clean 400 BEFORE any rate-limit or cap
  // reservation is consumed. (Banned/blocked/24h checks remain the handler's.)
  const recipient = await dbRead.user.findUnique({
    where: { id: toUserId },
    select: { id: true, deletedAt: true },
  });
  if (!recipient || recipient.deletedAt) {
    res.status(400).json({ error: 'Recipient not found' });
    return;
  }

  // ── The money attempt (rate-limit → reserve → charge). Returns a terminal
  //    outcome instead of writing `res` directly, so the idempotency wrapper can
  //    CACHE it (replay a lost-response retry) or RELEASE it (a transient 429/503
  //    may be retried). `subjectUserId` is non-null here (guarded above).
  const subjectId = subjectUserId;
  const attemptTip = async (): Promise<TipOutcome> => {
    // Per-instance rate limit (fail-CLOSED on redis error — money path).
    const rateLimit = await checkBlockTipRateLimit(claims.blockInstanceId);
    if (!rateLimit.allowed) {
      // TRANSIENT: a rate-limited attempt moved no money — a retry once the window
      // clears must be allowed to execute, so this is NOT cached under the idem key.
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
      return { status: 429, body: { error: 'Too many tips — please retry shortly.' }, transient: true };
    }

    const subjectUser = await hydrateBlockSubject(subjectId);
    if (!subjectUser) {
      return { status: 404, body: { error: 'User not found' } };
    }
    if (subjectUser.bannedAt) {
      return { status: 403, body: { error: 'banned' } };
    }
    if (subjectUser.muted) {
      return { status: 403, body: { error: 'Your account is restricted' } };
    }

    // PER-USER DAILY CAP — atomically RESERVE this tip against the user's UTC-day
    // aggregate BEFORE the money moves. Fail-CLOSED on a redis error (503). Over the
    // daily cap → refund the reservation + clean 400. The reservation stands only if
    // the tip transaction below resolves; any throw refunds it.
    let capKey: Awaited<ReturnType<typeof reserveBlockTipSpend>>['key'];
    try {
      const reserved = await reserveBlockTipSpend(subjectId, amount);
      capKey = reserved.key;
      if (reserved.total > BLOCK_TIP_CAP_PER_DAY) {
        await refundBlockTipSpend(capKey, amount);
        return {
          status: 400,
          body: {
            error: `Daily tip limit reached (${BLOCK_TIP_CAP_PER_DAY} Buzz). Try again tomorrow.`,
          },
        };
      }
    } catch {
      // TRANSIENT: the limiter is unavailable — a retry once redis recovers must be
      // allowed to execute, so this 503 is NOT cached under the idem key.
      return { status: 503, body: { error: 'Tip limiter unavailable; please retry' }, transient: true };
    }

    // Build a minimal ProtectedContext for the controller (it reads ctx.user +
    // ctx.track). The sender is ALWAYS the verified subject — never body input.
    const ctx = {
      user: subjectUser,
      track: new Tracker(req, res),
      ip: '',
      cache: null,
      req,
      res,
    } as unknown as ProtectedContext;

    try {
      const result = await createBuzzTipTransactionHandler({
        input: {
          toAccountId: toUserId,
          amount,
          fromAccountType: 'yellow',
          toAccountType: 'yellow',
          entityType,
          entityId,
        },
        ctx,
        // Ledger-backed idempotency (audit 🟡-1): derive the tip's
        // `externalTransactionId` from the client key so a retry after the Redis
        // sentinel expired (a crash between charge and finalize) collides on the
        // Buzz ledger's unique constraint = money moves once. The Redis sentinel
        // above stays the fast-path; this is the authoritative second layer.
        idempotencyKey,
      });

      // ── LEDGER-DEDUPED TIP → REFUND THE CAP RESERVATION (audit 🔴-2) ──────────
      // `dedupedAmount` is the Buzz the ledger REFUSED to move because the
      // deterministic `externalTransactionId` already existed — i.e. this call
      // debited that much less than we reserved above. Keeping the reservation would
      // charge the viewer's daily tip ALLOWANCE a second time for a transfer that
      // happened exactly once, which is not the "stricter is safer" case the refund
      // policy in the catch below is about: there we don't know whether money moved,
      // here the ledger has affirmatively told us it did not. Refund exactly the
      // deduped amount (0 on every normal tip → byte-identical to today).
      //
      // Replay ABUSE is not what the money cap holds: a replay is already bounded by
      // the per-instance 10-tips/60s limiter and the Redis idempotency sentinel, and
      // it moves no Buzz.
      if (result.dedupedAmount > 0) {
        await refundBlockTipSpend(capKey, result.dedupedAmount);
      }

      // W13 richer audit detail — stash a structured ref so the middleware
      // finish-writer records "Tipped N Buzz to @recipient" (the view resolves
      // toUserId → @username). Best-effort: `amount` is positive here (a credit TO
      // the recipient).
      //
      // 🔴 The ENTIRE enrichment (detail construction AND the stash call) is wrapped
      // in a swallow-everything try/catch so it can NEVER change this endpoint's
      // outcome. A successful tip ALWAYS returns its real 200 even if enrichment
      // throws — a missing/undefined stash export, a null-deref building the detail,
      // or a non-writable `res` all no-op the audit row, they do not 500 a tip whose
      // money already moved. (Regression: #3161's stash sat inside the money-path try
      // and a throw at the call site surfaced as a 500 on the happy path.)
      try {
        stashBlockActionDetail(res, {
          action: 'tip',
          amount,
          toUserId,
          ...(entityType ? { entityType } : {}),
          ...(entityId ? { entityId } : {}),
          outcome: 'ok',
        });
      } catch {
        /* audit enrichment is best-effort — it must never perturb the money path */
      }

      return {
        status: 200,
        body: {
          ok: true,
          tip: { toUserId, amount, entityType: entityType ?? null, entityId: entityId ?? null },
        },
      };
    } catch (error) {
      const trpcError = error as TRPCError;
      const statusCode =
        typeof trpcError?.code === 'string' ? getHTTPStatusCodeFromError(trpcError) : 500;

      // REFUND ONLY ON A KNOWN-PRE-MONEY FAILURE. In createBuzzTipTransactionHandler
      // the money moves at `createBuzzTransactionMany`; EVERY guard that runs before
      // it (self-tip, banned/blocked target, 24h age, and the balance pre-check →
      // insufficient funds) throws BAD_REQUEST — i.e. a 4xx GUARANTEES no Buzz left
      // the sender, so the reservation must be refunded. A 5xx (or a non-TRPC throw)
      // may originate AFTER the money moved (upsertBuzzTip / notification / metric),
      // so we must NOT refund it — keeping the reservation only makes the daily cap
      // STRICTER (the safe direction), never lets a real spend escape the ceiling.
      // (Fixes the latent cap-bypass where a post-money throw refunded the cap and
      // let the daily total under-count past the ceiling.)
      if (statusCode >= 400 && statusCode < 500) {
        await refundBlockTipSpend(capKey, amount);
      }

      // A 5xx is TERMINAL for idempotency (it may be a post-money failure) — caching
      // it means a lost-response retry replays the 5xx rather than re-attempting a
      // charge whose first pass may already have moved money.
      return {
        status: statusCode,
        body: { ok: false, error: trpcError?.message ?? 'Failed to send tip' },
      };
    }
  };

  // ── IDEMPOTENCY WRAPPER (item 2, tip half). Absent key → run once, today's
  //    behavior. Present key → claim-or-replay; finalize a terminal outcome so a
  //    lost-response retry replays it, release a transient one so it can re-run.
  if (idempotencyKey) {
    // Payload fingerprint (audit 🟡-1 residual) — pins the key to THIS request's
    // (recipient, amount, entity) so the same key reused for a DIFFERENT tip is
    // rejected rather than silently replaying the first tip's result.
    const fingerprint = computeTipFingerprint({ toUserId, amount, entityType, entityId });
    let claim: Awaited<ReturnType<typeof claimTipIdempotency>>;
    try {
      // Keyed per (user, APP, key) — audit 🟡-2. Without `claims.appBlockId`, two
      // apps the same user installed that pick the same literal key value share one
      // slot, and app B replays app A's body (learning A's recipient + amount).
      claim = await claimTipIdempotency(subjectId, claims.appBlockId, idempotencyKey, fingerprint);
    } catch {
      // Fail-CLOSED: a redis error at claim time → 503 (money endpoint must not
      // dedupe blind), consistent with the reserve path.
      res.status(503).json({ error: 'Tip idempotency unavailable; please retry' });
      return;
    }

    if (claim.state === 'mismatch') {
      // Same key, DIFFERENT payload. Replaying the first result would tell the app a
      // tip it never made succeeded; executing it would break the key's one-request
      // contract. Reject (non-retryable) — the client must mint a fresh key.
      res.status(422).json({
        error: 'This idempotency key was already used for a different tip',
      });
      return;
    }
    if (claim.state === 'replay') {
      // A prior attempt already produced a terminal result — replay it VERBATIM.
      // No second reserve, no second charge.
      res.status(claim.status).json(claim.body);
      return;
    }
    if (claim.state === 'in_progress') {
      // The first attempt is still in flight (or a lost/garbage record) — never
      // race a live first attempt into a double charge; ask the client to retry.
      res.setHeader('Retry-After', '2');
      res.status(409).json({ error: 'A tip with this idempotency key is already in progress' });
      return;
    }

    // state === 'acquired' — we own the first attempt.
    //
    // 🔴 RELEASE ON A THROW (audit 🟡-3). `attemptTip` returns a terminal outcome for
    // every failure it OWNS, but `hydrateBlockSubject(subjectId)` and
    // `new Tracker(req, res)` sit outside its inner try — a throw there ESCAPES past
    // both finalize and release. The sentinel would then survive its full 10-minute
    // TTL and 409 every retry with "already in progress" when NOTHING is in progress,
    // making the tip unlandable after a transient DB blip — precisely when retrying
    // with the same key is the entire point. No money moved (the throw is upstream of
    // the charge), so releasing is safe. The gen path already does this on its submit
    // catch; this makes the tip path consistent.
    let outcome: TipOutcome;
    try {
      outcome = await attemptTip();
    } catch (e) {
      await releaseTipIdempotency(claim.key);
      throw e;
    }
    if (outcome.transient) {
      await releaseTipIdempotency(claim.key);
    } else {
      await finalizeTipIdempotency(claim.key, outcome.status, outcome.body, fingerprint);
    }
    res.status(outcome.status).json(outcome.body);
    return;
  }

  const outcome = await attemptTip();
  res.status(outcome.status).json(outcome.body);
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'tip',
  requiredScope: 'social:tip:self',
  allowOpaqueOrigin: true,
});
