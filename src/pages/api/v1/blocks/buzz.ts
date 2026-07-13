import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { getUserBuzzAccount } from '~/server/services/buzz.service';

/**
 * GET /api/v1/blocks/buzz
 *
 * Block-side Buzz-balance readout. Scope `buzz:read:self`. Returns the token
 * SUBJECT's own (yellow) Buzz balance — a low-sensitivity self-read that powers a
 * page app's balance chrome. Self-bound: the balance is keyed on the verified
 * token subject, never client input; anon tokens are rejected (no "self").
 *
 * Response: `{ balance }`.
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
    res.status(403).json({ error: 'Anonymous block tokens may not read a balance' });
    return;
  }

  try {
    const accounts = await getUserBuzzAccount({ accountId: subjectUserId, accountType: 'yellow' });
    res.status(200).json({ balance: accounts[0]?.balance ?? 0 });
    return;
  } catch {
    res.status(502).json({ error: 'Failed to read balance' });
    return;
  }
});

export default withBlockScope(baseHandler, { requiredScope: 'buzz:read:self' });
