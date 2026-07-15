import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { getBlockBuzzDailyCompensationQuery } from '~/server/schema/buzz.schema';
import { getDailyCompensationRewardByUser } from '~/server/services/buzz.service';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

/**
 * GET /api/v1/blocks/buzz/daily-compensation
 *
 * Block-side per-modelVersion generation-compensation readout. Scope
 * `buzz:read:self`. Returns the token SUBJECT's own daily compensation rows for
 * the MONTH containing `date` (that windowing lives in the service). Self-bound:
 * userId comes from the verified token subject, never client input; anon tokens
 * are rejected (no "self").
 *
 * Query: `date` (ISO; required), `source` compensation|licenseFee (default
 * compensation), `accountType?`.
 *
 * Response: `{ resources[], hasPublishedResources }` — per-modelVersion daily
 * totals, buzz + cash. Cash amounts are in TENTHS of a penny (client ÷ 10).
 */

const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
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
    res.status(403).json({ error: 'Anonymous block tokens may not read compensation' });
    return;
  }

  const parsed = getBlockBuzzDailyCompensationQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { date, source, accountType } = parsed.data;

  try {
    const result = await getDailyCompensationRewardByUser({
      userId: subjectUserId,
      date,
      source,
      accountType,
    });
    res.status(200).json(result);
    return;
  } catch (e) {
    handleEndpointError(res, e);
    return;
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// ../buzz.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'buzz_daily_compensation',
  requiredScope: 'buzz:read:self',
  allowOpaqueOrigin: true,
});
