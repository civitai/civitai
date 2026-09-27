import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import {
  parseSubjectUserId,
  stashBlockActionDetail,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  purchaseBlockGood,
  resolveBlockGoodForPurchase,
} from '~/server/services/blocks/block-goods.service';
import {
  BLOCK_GOOD_CAP_PER_DAY,
  checkBlockGoodRateLimit,
  claimGoodIdempotency,
  computeGoodPurchaseFingerprint,
  finalizeGoodIdempotency,
  refundBlockGoodSpend,
  releaseGoodIdempotency,
  reserveBlockGoodSpend,
} from '~/server/utils/block-goods-rate-limit';
import {
  BLOCK_GOOD_ID_RE,
  BLOCK_GOOD_MAX_PRICE_BUZZ,
} from '~/shared/constants/block-goods.constants';
import { BLOCK_IDEMPOTENCY_KEY_REGEX } from '~/server/utils/block-gen-idempotency';

/**
 * POST /api/v1/blocks/goods/purchase
 * Body `{ goodId, expectedPriceBuzz?, idempotencyKey? }` — scope
 * `goods:purchase:self`.
 *
 * Buys ONE manifest-declared DIGITAL GOOD for the token SUBJECT, in Buzz. The
 * platform records the sale, grants the entitlement, and pays the app owner
 * their 70% immediately; the good's meaning is the app's business.
 *
 * 🔴 FIN-1 — EVERY MONEY INPUT IS SERVER-DERIVED. The buyer is the verified
 * subject, never a body field. The app, its owner, the good and its PRICE come
 * from the APPROVED `AppBlock` row that `claims.appBlockId` names; a body may
 * not name an app, an owner, a price or a buyer, and unknown keys are stripped
 * by the schema below rather than honoured. `expectedPriceBuzz` is the one
 * price-shaped input a client may send and it can only cause a REFUSAL — it is
 * compared against the server price, never used as one.
 *
 * PAGE-SAFE BY BOUNDING, the same argument that puts `social:tip:self` on a page
 * (see `PAGE_FORBIDDEN_SCOPES`): the price is review-gated AND hard-capped per
 * purchase (BLOCK_GOOD_MAX_PRICE_BUZZ), and a per-user daily ceiling
 * (BLOCK_GOOD_CAP_PER_DAY, reserve-and-refund) bounds the day across every app
 * the viewer has installed. Over either → a clean 4xx, never a 500.
 *
 * IDEMPOTENCY, two layers.
 *   1. An OPTIONAL client `idempotencyKey`, pinned to a payload fingerprint,
 *      with a Redis sentinel (fail-CLOSED). Same key + same payload in flight →
 *      409; terminal → replayed verbatim; different payload → 422.
 *   2. The LEDGER. The charge's `externalTransactionIdPrefix` is derived from
 *      (app, good, buyer) alone — no randomness, no client key — so the Buzz
 *      service refuses a second charge forever, and `block_good_purchase`
 *      carries the same string under a UNIQUE index, which is how the conflict
 *      becomes observable. A conflict REFUNDS the daily-cap reservation burned
 *      for Buzz that never moved.
 *
 * A throw that escapes the attempt RELEASES the claim rather than stranding a
 * 10-minute "already in progress" sentinel over nothing.
 */

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

const bodySchema = z.object({
  goodId: z.string().regex(BLOCK_GOOD_ID_RE),
  // Confirm-the-price guard. Bounded by the same ceiling the catalog is, so a
  // nonsense value is a 400 rather than a comparison that can never match.
  expectedPriceBuzz: z.number().int().positive().max(BLOCK_GOOD_MAX_PRICE_BUZZ).optional(),
  // Charset-restricted so no control characters flow into a redis key.
  idempotencyKey: z.string().regex(BLOCK_IDEMPOTENCY_KEY_REGEX).optional(),
});

/** A terminal HTTP outcome. `transient` outcomes (429/503) are NOT cached. */
type PurchaseOutcome = { status: number; body: unknown; transient?: boolean };

// Exported for unit testing — the default export is wrapped in withBlockScope,
// whose JWT gate would otherwise have to be satisfied to reach this handler.
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
    res.status(403).json({ error: 'Anonymous block tokens may not buy items' });
    return;
  }

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }
  const { goodId, expectedPriceBuzz, idempotencyKey } = parsed.data;

  const buyerUserId = subjectUserId;
  const appBlockId = claims.appBlockId;

  // Resolved BEFORE any reservation so the fingerprint and the cap are computed
  // against the SERVER price. Pricing the reservation off `expectedPriceBuzz`
  // would let a client under-reserve and walk past the daily ceiling.
  const resolved = await resolveBlockGoodForPurchase({ appBlockId, goodId });
  if (!resolved) {
    res.status(404).json({ ok: false, error: 'This item is not available' });
    return;
  }
  const priceBuzz = resolved.good.priceBuzz;

  const attemptPurchase = async (): Promise<PurchaseOutcome> => {
    const rateLimit = await checkBlockGoodRateLimit(claims.blockInstanceId);
    if (!rateLimit.allowed) {
      // TRANSIENT: nothing moved, so a retry once the window clears must be able
      // to execute — not cached under the idempotency key.
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
      return {
        status: 429,
        body: { error: 'Too many purchases — please retry shortly.' },
        transient: true,
      };
    }

    let capKey: Awaited<ReturnType<typeof reserveBlockGoodSpend>>['key'];
    try {
      const reserved = await reserveBlockGoodSpend(buyerUserId, priceBuzz);
      capKey = reserved.key;
      if (reserved.total > BLOCK_GOOD_CAP_PER_DAY) {
        await refundBlockGoodSpend(capKey, priceBuzz);
        return {
          status: 400,
          body: {
            error: `Daily purchase limit reached (${BLOCK_GOOD_CAP_PER_DAY} Buzz). Try again tomorrow.`,
          },
        };
      }
    } catch {
      // TRANSIENT: the limiter is unavailable — not cached.
      return {
        status: 503,
        body: { error: 'Purchase limiter unavailable; please retry' },
        transient: true,
      };
    }

    // An unexpected throw here may have landed AFTER the charge, so it is
    // deliberately NOT caught to refund the reservation: keeping it only makes
    // the day's ceiling stricter, which is the safe direction. Refunding on an
    // unknown outcome is what would let real spend escape the cap. The
    // idempotency wrapper below still releases the claim.
    const result = await purchaseBlockGood({
      buyerUserId,
      appBlockId,
      blockInstanceId: claims.blockInstanceId,
      goodId,
      resolved,
      expectedPriceBuzz,
      // Blue first, then yellow — a viewer's granted Buzz is spent before the
      // Buzz they bought, and the owner is paid back in the same proportion.
      payWith: ['blue', 'yellow'],
    });

    if (!result.ok) {
      // 🔴 REFUND ONLY ON A KNOWN-PRE-MONEY REFUSAL. Everything the service
      // returns as a 4xx is decided before or instead of the charge — the
      // catalog lookup, the price guard, ownership, the cap, and a ledger
      // conflict, which is the case the brief calls out: the ledger refused to
      // move Buzz a second time, so keeping the reservation would charge the
      // viewer's daily allowance twice for one transfer. A 5xx may be
      // post-money, so it keeps the reservation (stricter, never looser).
      if (result.status >= 400 && result.status < 500) {
        await refundBlockGoodSpend(capKey, priceBuzz);
      }
      return {
        status: result.status,
        body: { ok: false, error: result.error, code: result.code },
      };
    }

    // Audit enrichment is best-effort and wrapped so it can NEVER change the
    // outcome of a purchase whose money already moved.
    try {
      stashBlockActionDetail(res, {
        action: 'goods.purchase',
        goodId,
        amount: result.priceBuzz,
        outcome: 'ok',
      });
    } catch {
      /* audit enrichment must never perturb the money path */
    }

    return {
      status: 200,
      body: {
        ok: true,
        purchase: { id: result.purchaseId, goodId: result.goodId, priceBuzz: result.priceBuzz },
        entitlement: result.entitlement,
      },
    };
  };

  if (idempotencyKey) {
    const fingerprint = computeGoodPurchaseFingerprint({ appBlockId, goodId, priceBuzz });
    let claim: Awaited<ReturnType<typeof claimGoodIdempotency>>;
    try {
      claim = await claimGoodIdempotency(buyerUserId, appBlockId, idempotencyKey, fingerprint);
    } catch {
      // Fail-CLOSED: a money endpoint must not dedupe blind.
      res.status(503).json({ error: 'Purchase idempotency unavailable; please retry' });
      return;
    }

    if (claim.state === 'mismatch') {
      res.status(422).json({
        error: 'This idempotency key was already used for a different purchase',
      });
      return;
    }
    if (claim.state === 'replay') {
      res.status(claim.status).json(claim.body);
      return;
    }
    if (claim.state === 'in_progress') {
      res.setHeader('Retry-After', '2');
      res
        .status(409)
        .json({ error: 'A purchase with this idempotency key is already in progress' });
      return;
    }

    // state === 'acquired' — we own the first attempt. A throw that escapes it
    // must RELEASE the claim: otherwise the sentinel survives its full TTL and
    // 409s every retry with "already in progress" when nothing is, making the
    // purchase unlandable after a transient blip — precisely when retrying with
    // the same key is the whole point.
    let outcome: PurchaseOutcome;
    try {
      outcome = await attemptPurchase();
    } catch (e) {
      await releaseGoodIdempotency(claim.key);
      throw e;
    }
    if (outcome.transient) {
      await releaseGoodIdempotency(claim.key);
    } else {
      await finalizeGoodIdempotency(claim.key, outcome.status, outcome.body, fingerprint);
    }
    res.status(outcome.status).json(outcome.body);
    return;
  }

  const outcome = await attemptPurchase();
  res.status(outcome.status).json(outcome.body);
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// tip.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'goods_purchase',
  requiredScope: 'goods:purchase:self',
  allowOpaqueOrigin: true,
});
