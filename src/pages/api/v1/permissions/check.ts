import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { EntityAccessPermission } from '~/server/common/enums';
import { hasEntityAccess } from '~/server/services/common.service';
import { getSessionUser } from '~/server/services/user.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray, numericString } from '~/utils/zod-helpers';

const schema = z.object({
  entityType: z.enum(['ModelVersion']).default('ModelVersion'),
  entityIds: commaDelimitedNumberArray(),
  userId: numericString().optional(),
  permission: z.enum(['Generate']).default('Generate'),
});

export default PublicEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse) {
    const results = schema.safeParse(req.query);
    if (!results.success)
      return res.status(400).json({ error: `Could not parse provided model versions array.` });

    const { entityIds, entityType, permission: publicPermission, userId } = results.data;

    if (entityIds.length === 0) {
      return res.status(200).json([]);
    }

    const permissions =
      publicPermission === 'Generate' ? EntityAccessPermission.EarlyAccessGeneration : null;

    if (!permissions) {
      return res.status(400).json({ error: 'Invalid permission' });
    }

    const sessionUser = await getSessionUser({ userId });

    try {
      const access = await hasEntityAccess({
        userId,
        isModerator: sessionUser?.isModerator,
        entityType,
        entityIds,
        permissions,
      });

      const data: Record<number, boolean> = {};

      access.forEach((r) => {
        data[r.entityId] = r.hasAccess;
      });

      return res.json(data);
    } catch (error) {
      return res.status(500).json({ message: 'An unexpected error occurred', error });
    }
  },
  ['GET']
);
