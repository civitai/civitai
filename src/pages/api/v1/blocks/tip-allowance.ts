import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { readBlockTipAllowance } from '~/server/utils/block-tip-rate-limit';

/**
 * GET /api/v1/blocks/tip-allowance — scope `social:tip:self`.
 *
 * Returns the viewer's CURRENT daily tip allowance `{ cap, spent, remaining }`
 * from the SAME authoritative `tip-cap` Redis counter the tip endpoint's
 * reserve/refund path mutates (BLOCK_TIP_CAP_PER_DAY). This lets a block show a
 * genuinely-tracked remaining allowance and disable the tip button at the true
 * ceiling — instead of the dead client-side full-cap guess (`localStorage` is
 * inert in the opaque-origin sandbox).
 *
 * Reuses the `social:tip:self` scope the app already holds to tip (no new scope /
 * manifest change). Self-bound: the subject is the verified token subject; anon
 * tokens are rejected (there is no "self" allowance to read). `spent` is
 * reservation-based (net-committed-today) so it can briefly over-count between a
 * reserve and its refund — the SAFE direction (under-reports `remaining`).
 *
 * FAIL-CLOSED on a redis error (503) — consistent with the reserve path; a
 * fabricated full allowance on a blip would invite tipping past a ceiling the
 * enforcing reserve then rejects.
 *
 * CORS: withBlockScope + allowOpaqueOrigin (an unverified block direct-fetches
 * this from `Origin: null`; the Bearer block-JWT is the sole authz gate).
 */
const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    // withBlockScope only invokes this handler with a valid block JWT; defense
    // in depth.
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
    res.status(403).json({ error: 'Anonymous block tokens have no tip allowance' });
    return;
  }

  try {
    const allowance = await readBlockTipAllowance(subjectUserId);
    res.status(200).json(allowance);
  } catch {
    // Fail-CLOSED (redis error) → retryable 503, mirroring the reserve path.
    res.status(503).json({ error: 'Tip allowance unavailable; please retry' });
  }
});

export default withBlockScope(baseHandler, {
  endpoint: 'tip_allowance',
  requiredScope: 'social:tip:self',
  allowOpaqueOrigin: true,
});
