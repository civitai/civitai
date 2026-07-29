import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import { dbWrite } from '~/server/db/client';
import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';

/**
 * GET /api/v1/blocks/me
 *
 * Block-side identity endpoint. Returns a minimal viewer profile derived
 * from the block JWT subject claim. Distinct from /api/v1/me by design:
 *
 *   - /api/v1/me uses AuthedEndpoint (session cookie or API key/OAuth);
 *     wrapping it with withBlockScope dead-codes the block path because
 *     the inner session check 401s first.
 *   - This route's outer auth IS withBlockScope; there is no session
 *     fallback. Anon block tokens are rejected (no anonymous viewer
 *     identity).
 *
 * Scope: `user:read:self` (audit I3). The previous gate was buzz:read:self,
 * which forced every block that wanted a viewer name to ask for a
 * buzz-bit scope — semantic mismatch + over-privileged. user:read:self
 * is the least-privileged scope that conveys "viewer identity."
 *
 * buzzBudget is still surfaced on the response when the JWT carries the
 * ai:write:budgeted claim — a block that wants the budget along with
 * identity asks for both scopes in its manifest.
 *
 * CORS: handled in withBlockScope from BLOCK_ALLOWED_ORIGINS.
 */
const baseHandler = withAxiom(async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    // withBlockScope only invokes this handler when a valid block JWT
    // is present; this guard exists for defense in depth.
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  let userId: number | null;
  try {
    userId = parseSubjectUserId(claims.sub);
  } catch {
    res.status(403).json({ error: 'Invalid subject claim' });
    return;
  }
  if (userId == null) {
    res.status(403).json({ error: 'Anonymous block tokens may not call /blocks/me' });
    return;
  }

  // M1: dbWrite for ban/mute/deleted lookup. The token endpoint uses
  // dbWrite for the same check; reading from the replica here lets a
  // banned-during-replication-lag user surface to the block as active.
  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      bannedAt: true,
      muted: true,
      deletedAt: true,
      isModerator: true,
    },
  });
  if (!user || user.deletedAt) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  // Phase 2: App Blocks is moderator-only until GA. Block-token minting is
  // mod-gated, but a token minted just before a demotion is valid for ~15min;
  // re-assert the resolved viewer is a moderator as defense-in-depth.
  if (!user.isModerator) {
    res.status(403).json({ error: 'Apps are restricted to the Civitai team' });
    return;
  }
  // M1+M6: a banned user with a still-valid session must NOT be surfaced
  // to blocks as a real viewer. The token-issuance endpoint already gates
  // on this, but a token minted just before a ban is still valid for up to
  // 15 minutes. Reject here as a second line of defense. Muted users pass
  // through with `status: 'muted'` so the block can suppress write UI.
  if (user.bannedAt) {
    res.status(403).json({ error: 'banned' });
    return;
  }

  res.status(200).json({
    id: user.id,
    username: user.username,
    status: user.muted ? 'muted' : 'active',
    // buzzBudget is the per-call spend cap the block was issued with —
    // surfaces here so the block can clamp UI without a second API call.
    buzzBudget: claims.buzzBudget ?? null,
  });
});

export default withBlockScope(baseHandler, { endpoint: 'me', requiredScope: 'user:read:self' });
