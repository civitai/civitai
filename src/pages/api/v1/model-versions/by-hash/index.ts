import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { isProd } from '~/env/other';
import { prepareModelVersionResponse } from '~/pages/api/v1/model-versions/[id]';
import { apiBrowsingLevel } from '~/server/utils/browsing-level';
import { showsSfwFace } from '~/shared/utils/model-sfw-face';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { dbRead } from '~/server/db/client';
import { getModelVersionApiSelect } from '~/server/selectors/modelVersion.selector';
import { getImagesForModelVersion } from '~/server/services/image.service';
import {
  getHiddenModelVersionIds,
  isPrivateModelVersion,
} from '~/server/services/model-visibility.service';
import { getPublicPaidAccessForModelVersions } from '~/server/services/paid-access.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z
  .array(
    z
      .string()
      .refine((hash) => hash.length === 64, { error: 'Invalid hash' })
      .transform((hash) => hash.toUpperCase())
  )
  .max(100, { error: 'Too many hashes' });

export default PublicEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse) {
    const results = schema.safeParse(req.body);
    if (!results.success)
      return res.status(400).json({
        error: `Request must include an array of SHA256 Hashes. ${results.error.message}`,
      });

    const matched = await dbRead.modelFile.findMany({
      where: {
        hashes: { some: { hash: { in: results.data }, type: 'SHA256' } },
        modelVersion: { model: { status: 'Published' }, status: 'Published' },
      },
      select: {
        modelVersion: {
          select: getModelVersionApiSelect,
        },
      },
    });

    // Versions the caller may not see are left out, as if their hashes had not matched.
    const hidden = await getHiddenModelVersionIds(
      matched.map((file) => file.modelVersion),
      async () => (await getServerAuthSession({ req, res }))?.user
    );
    const files = matched.filter((file) => !hidden.has(file.modelVersion.id));

    const modelVersionIds = [...new Set(files.map((file) => file.modelVersion.id))];
    const images = await getImagesForModelVersion({
      modelVersionIds,
      imagesPerVersion: 10,
      include: ['meta'],
    });
    const paidAccess = await getPublicPaidAccessForModelVersions(modelVersionIds);

    // Matches `resModelVersionDetails` in ./[id], which shapes the singular
    // by-hash response through the same `prepareModelVersionResponse`. The two
    // must derive the base URL identically or the batch and single lookups
    // advertise different download hosts for the same file.
    const baseUrl = new URL(
      isProd && req.headers.host ? `https://${req.headers.host}` : 'http://localhost:3000'
    );
    const showSfwFace = showsSfwFace(apiBrowsingLevel(req));
    const modelVersions = await Promise.all(
      files.map((file) =>
        prepareModelVersionResponse(
          file.modelVersion,
          baseUrl,
          images.filter((x) => x.modelVersionId === file.modelVersion.id),
          paidAccess[file.modelVersion.id] ?? null,
          showSfwFace
        )
      )
    );

    // Only its owner or a moderator is still holding a Private version here.
    if (files.some((file) => isPrivateModelVersion(file.modelVersion)))
      res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(modelVersions);
  },
  ['POST']
);
