import type { AxiomAPIRequest } from '@civitai/next-axiom';
import type { NextApiResponse } from 'next';
import type { SessionUser } from 'next-auth';
import * as z from 'zod';
import { manageSanityChecks } from '~/server/services/games/new-order.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const manageSanityChecksSchema = z
  .object({
    add: commaDelimitedNumberArray().optional(),
    remove: commaDelimitedNumberArray().optional(),
  })
  .refine((data) => data.add || data.remove, {
    message: 'At least one of "add" or "remove" must be provided',
  });

export default ModEndpoint(
  async function (req: AxiomAPIRequest, res: NextApiResponse, user: SessionUser) {
    // Check moderator permissions
    if (!user.isModerator) {
      return res.status(401).json({ error: 'Insufficient permissions' });
    }

    // Check feature flag
    const features = getFeatureFlags({ user, req });
    if (!features.newOrderGame) {
      return res.status(403).json({ error: 'Feature not available' });
    }

    try {
      const input = manageSanityChecksSchema.parse(req.query);
      const { add, remove } = input;

      const result = await manageSanityChecks({ add, remove });

      return res.status(200).json(result);
    } catch (error) {
      req.log.error('Error managing sanity checks:', error as Error);

      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation error',
          details: z.treeifyError(error),
        });
      }

      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  },
  ['POST']
);
