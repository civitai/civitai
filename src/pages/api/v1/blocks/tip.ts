import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import type { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import * as z from 'zod';

import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { createBuzzTipTransactionHandler } from '~/server/controllers/buzz.controller';
import { Tracker } from '~/server/clickhouse/client';
import type { ProtectedContext } from '~/server/createContext';
import { hydrateBlockSubject } from '~/server/services/blocks/block-collections.service';
import {
  BLOCK_TIP_CAP_PER_DAY,
  BLOCK_TIP_MAX_PER_TIP,
  checkBlockTipRateLimit,
  refundBlockTipSpend,
  reserveBlockTipSpend,
} from '~/server/utils/block-tip-rate-limit';

/**
 * POST /api/v1/blocks/tip
 * Body `{ toUserId, amount, entityType?, entityId? }` — scope `social:tip:self`.
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
 */

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

const bodySchema = z.object({
  toUserId: z.number().int().positive(),
  // Per-tip cap is the schema's hard upper bound — over-per-tip → clean 400.
  amount: z.number().int().positive().max(BLOCK_TIP_MAX_PER_TIP),
  entityType: z.enum(['Image', 'Collection', 'User']).optional(),
  entityId: z.number().int().positive().optional(),
});

const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
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
  const { toUserId, amount, entityType, entityId } = parsed.data;

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

  // Per-instance rate limit (fail-CLOSED on redis error — money path).
  const rateLimit = await checkBlockTipRateLimit(claims.blockInstanceId);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: 'Too many tips — please retry shortly.' });
    return;
  }

  const subjectUser = await hydrateBlockSubject(subjectUserId);
  if (!subjectUser) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (subjectUser.bannedAt) {
    res.status(403).json({ error: 'banned' });
    return;
  }
  if (subjectUser.muted) {
    res.status(403).json({ error: 'Your account is restricted' });
    return;
  }

  // PER-USER DAILY CAP — atomically RESERVE this tip against the user's UTC-day
  // aggregate BEFORE the money moves. Fail-CLOSED on a redis error (503). Over the
  // daily cap → refund the reservation + clean 400. The reservation stands only if
  // the tip transaction below resolves; any throw refunds it.
  let capKey: Awaited<ReturnType<typeof reserveBlockTipSpend>>['key'];
  try {
    const reserved = await reserveBlockTipSpend(subjectUserId, amount);
    capKey = reserved.key;
    if (reserved.total > BLOCK_TIP_CAP_PER_DAY) {
      await refundBlockTipSpend(capKey, amount);
      res.status(400).json({
        error: `Daily tip limit reached (${BLOCK_TIP_CAP_PER_DAY} Buzz). Try again tomorrow.`,
      });
      return;
    }
  } catch {
    res.status(503).json({ error: 'Tip limiter unavailable; please retry' });
    return;
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
    await createBuzzTipTransactionHandler({
      input: {
        toAccountId: toUserId,
        amount,
        fromAccountType: 'yellow',
        toAccountType: 'yellow',
        entityType,
        entityId,
      },
      ctx,
    });

    res.status(200).json({
      ok: true,
      tip: { toUserId, amount, entityType: entityType ?? null, entityId: entityId ?? null },
    });
    return;
  } catch (error) {
    // The tip did NOT move money — refund the daily-cap reservation so a failed
    // attempt (insufficient funds, banned target, …) doesn't burn the user's cap.
    await refundBlockTipSpend(capKey, amount);
    // The handler wraps everything in a TRPCError (getTRPCErrorFromUnknown):
    // insufficient funds / self-tip / banned target → BAD_REQUEST (400); etc.
    const trpcError = error as TRPCError;
    const statusCode =
      typeof trpcError?.code === 'string' ? getHTTPStatusCodeFromError(trpcError) : 500;
    res
      .status(statusCode)
      .json({ ok: false, error: trpcError?.message ?? 'Failed to send tip' });
    return;
  }
});

export default withBlockScope(baseHandler, { requiredScope: 'social:tip:self' });
