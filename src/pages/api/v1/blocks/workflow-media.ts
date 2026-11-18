import type { NextApiRequest, NextApiResponse } from 'next';
import { recordBlockClaimsRateLimitRefusal } from '~/server/services/blocks/rate-limit-refusal.service';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { resolveWorkflowMediaForBlockClaims } from '~/server/services/blocks/block-media-serving';
import { WORKFLOW_MEDIA_MAX_REFS } from '~/shared/constants/block-workflow-media.constants';
import { checkBlockCatalogRateLimit } from '~/server/utils/block-catalog-rate-limit';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

const bodySchema = z.object({
  refs: z.string().min(1).max(2048).array().min(1).max(WORKFLOW_MEDIA_MAX_REFS),
});

/** REST twin of the `GET_WORKFLOW_MEDIA` bridge message (`blocks.getWorkflowMedia`). */
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

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }

  const rate = await checkBlockCatalogRateLimit(claims.blockInstanceId);
  if (!rate.allowed) {
    recordBlockClaimsRateLimitRefusal({
      claims,
      surface: 'rest',
      bucket: 'catalog',
      endpoint: 'workflow_media',
      retryAfterSeconds: rate.retryAfterSeconds,
    });
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    return;
  }

  try {
    res
      .status(200)
      .json(await resolveWorkflowMediaForBlockClaims({ claims, refs: parsed.data.refs }));
  } catch (error) {
    return handleEndpointError(res, error);
  }
});

export default withBlockScope(baseHandler, {
  endpoint: 'workflow_media',
  allowOpaqueOrigin: true,
});
