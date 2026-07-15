import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { getBlockBuzzTransactionsQuery } from '~/server/schema/buzz.schema';
import { getUserBuzzTransactions } from '~/server/services/buzz.service';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import { TransactionType } from '~/shared/constants/buzz.constants';

/**
 * GET /api/v1/blocks/buzz/transactions
 *
 * Block-side Buzz-ledger readout. Scope `buzz:read:self`. Pages the token
 * SUBJECT's own transactions for ONE pool per call (per-pool cursors upstream).
 * Self-bound: the account is keyed on the verified token subject, never client
 * input; anon tokens are rejected (no "self").
 *
 * Query: `accountType` (default yellow — see blockBuzzAccountTypes), `type?`
 * (TransactionType NAME, e.g. "Tip"), `cursor?`/`start?`/`end?` (ISO dates),
 * `limit` 1–200 (default 50).
 *
 * Response: `{ cursor, transactions[] }`. Rows keep `description`, `details`
 * (entity attribution), and `externalTransactionId` (reward/challenge
 * classification); `type` is serialized as its name; counterparties are
 * projected to `{ id, username }` only.
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
    res.status(403).json({ error: 'Anonymous block tokens may not read transactions' });
    return;
  }

  const parsed = getBlockBuzzTransactionsQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { accountType, type, cursor, start, end, limit } = parsed.data;

  try {
    const { cursor: nextCursor, transactions } = await getUserBuzzTransactions({
      accountId: subjectUserId,
      accountType,
      type: type ? TransactionType[type] : undefined,
      cursor,
      start,
      end,
      limit,
    });

    res.status(200).json({
      cursor: nextCursor,
      transactions: transactions.map(({ toUser, fromUser, ...t }) => ({
        ...t,
        type: TransactionType[t.type],
        toUser: toUser ? { id: toUser.id, username: toUser.username } : undefined,
        fromUser: fromUser ? { id: fromUser.id, username: fromUser.username } : undefined,
      })),
    });
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
  endpoint: 'buzz_transactions',
  requiredScope: 'buzz:read:self',
  allowOpaqueOrigin: true,
});
