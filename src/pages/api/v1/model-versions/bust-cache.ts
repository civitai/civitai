import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { bustMvCache } from '~/server/services/model-version.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import type { SessionUser } from '~/types/session';

const schema = z.object({
  versionIds: z.array(z.number().int().positive()).min(1).max(500),
});

// Cache invalidation for versions the Creator Studio wrote DIRECTLY. It edits `licensingFee` and
// `usageControl` with kysely against the shared database, which the main app's caches have no way to
// observe — so a change would otherwise stay invisible on-site until the TTL expired (up to a day for
// imagesForModelVersionsCache). The spoke calls this immediately after those writes.
//
// The cache set deliberately stays here: bustMvCache spans six caches, a CDN purge and the search-index
// queue, and a second copy of that list in the spoke would drift the first time one is added.
export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid request body', details: parsed.error.flatten() });
    }

    // Scoped to the caller's own versions — reachable with a session cookie, and a bust is cheap but not
    // free. Unknown/foreign ids are silently dropped rather than erroring: the caller already made its
    // write, and failing here would imply the write failed too.
    const rows = await dbRead.modelVersion.findMany({
      where: {
        id: { in: parsed.data.versionIds },
        ...(user.isModerator ? {} : { model: { userId: user.id } }),
      },
      select: { id: true, modelId: true },
    });
    if (!rows.length) return res.status(200).json({ busted: 0 });

    await bustMvCache(
      rows.map((r) => r.id),
      [...new Set(rows.map((r) => r.modelId))]
    );

    return res.status(200).json({ busted: rows.length });
  },
  ['POST']
);
