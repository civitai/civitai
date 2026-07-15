import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { blockBuzzAccountTypes } from '~/server/schema/buzz.schema';
import { getUserBuzzAccount } from '~/server/services/buzz.service';

/**
 * GET /api/v1/blocks/buzz/accounts
 *
 * Block-side all-pool balance readout. Scope `buzz:read:self`. Returns the
 * token SUBJECT's balance for every pool in blockBuzzAccountTypes — the three
 * spendable types plus the creator payout pools (creator bank / cashPending /
 * cashSettled) the single-pool ../buzz.ts endpoint doesn't cover. Self-bound:
 * balances are keyed on the verified token subject, never client input; anon
 * tokens are rejected (no "self").
 *
 * Response: `{ accounts: [{ accountType, balance }] }`.
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
    res.status(403).json({ error: 'Anonymous block tokens may not read balances' });
    return;
  }

  try {
    const accounts = await getUserBuzzAccount({
      accountId: subjectUserId,
      accountTypes: [...blockBuzzAccountTypes],
    });
    res.status(200).json({
      accounts: accounts.map(({ accountType, balance }) => ({ accountType, balance })),
    });
    return;
  } catch {
    res.status(502).json({ error: 'Failed to read balances' });
    return;
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// ../buzz.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'buzz_accounts',
  requiredScope: 'buzz:read:self',
  allowOpaqueOrigin: true,
});
