import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { getUserBuzzAccounts } from '~/server/services/buzz.service';

/**
 * GET /api/v1/blocks/buzz
 *
 * Block-side Buzz-balance readout. Scope `buzz:read:self`. Returns the token
 * SUBJECT's own per-pool Buzz balance — a low-sensitivity self-read that powers a
 * page app's balance chrome. Self-bound: the balance is keyed on the verified
 * token subject, never client input; anon tokens are rejected (no "self").
 *
 * Response: `{ blue, green, yellow }` — three finite numbers, a BARE object with
 * no envelope.
 *
 * 🔴 THE SHAPE IS THE BRIDGE'S, DELIBERATELY. This route is the REST twin of the
 * host-mediated `blocks.getMyBuzzBalance` tRPC mutation
 * (`~/server/routers/blocks.router.ts`), which is what `@civitai/blocks-react`'s
 * `useBuzzBalance()` reads today. That procedure projects
 * `getUserBuzzAccounts({ userId })` — every spendable pool — down to the three
 * the UI needs, defaulting a missing pool to 0 and omitting the internal types
 * (red / creatorProgram / cash). This route returns the SAME projection, field
 * for field, so a consumer can switch transports without a shape change. The
 * pre-deletion version of this file returned yellow-only (`{ balance }`); that
 * is the one deliberate difference from `16df584bcd^`.
 *
 * ⚠️ KNOWN DIVERGENCE FROM THE BRIDGE, stated rather than silently closed: the
 * tRPC procedure additionally evaluates the `app-blocks-enabled` kill-switch
 * against the token subject and charges the per-instance CATALOG rate-limit
 * bucket. This route does neither — it carries exactly the gates the deleted
 * file carried, plus `withBlockScope`'s own approved-status gate. Adding them
 * here is a behaviour change, not a restoration, so it is left for a follow-up.
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
    // getUserBuzzAccounts returns every spend type; project to just the three
    // spendable types the UI needs (omit red / creator-program / cash). Mirrors
    // blocks.getMyBuzzBalance exactly — see the docblock.
    const accounts = await getUserBuzzAccounts({ userId: subjectUserId });
    res.status(200).json({
      blue: accounts.blue ?? 0,
      green: accounts.green ?? 0,
      yellow: accounts.yellow ?? 0,
    });
    return;
  } catch {
    res.status(502).json({ error: 'Failed to read balance' });
    return;
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'buzz',
  requiredScope: 'buzz:read:self',
  allowOpaqueOrigin: true,
});
