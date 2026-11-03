import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { isGeneratorEvidenceDetails } from '~/server/services/generator-evidence/evidence-meta';
import { readVerifiedEvidence } from '~/server/services/generator-evidence/evidence-payload';
import { readEvidenceObject, sha256Hex } from '~/server/services/generator-evidence/evidence-store';
import { evidenceViewActivity } from '~/server/services/generator-evidence/evidence-views';
import { trackModActivity } from '~/server/services/moderator.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import type { SessionUser } from '~/types/session';

export const config = { api: { responseLimit: false } };

const query = z.object({
  reportId: z.coerce.number().int().positive().max(2_147_483_647),
  blobId: z.string().min(1).max(200),
});

const SERVABLE = /^(image|video)\//i;

/**
 * One preserved file of a generator evidence report, from the evidence copy. The browser names the
 * report and the blob; the storage key comes from the report. Every serve is recorded as that
 * moderator's view of the file, which is what the send reports as viewed.
 */
async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
  res.setHeader('cache-control', 'private, no-store');
  if (!getFeatureFlags({ user, req }).csamReports)
    return void res.status(403).json({ error: 'Forbidden' });

  const parsed = query.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: 'Bad request' });
  const { reportId, blobId } = parsed.data;

  const report = await dbRead.csamReport.findFirst({
    where: { id: reportId, type: 'GeneratedImage' },
    select: { details: true },
  });
  if (!report || !isGeneratorEvidenceDetails(report.details))
    return void res.status(404).json({ error: 'Not found' });
  const blob = report.details.generatedImages
    .flatMap((job) => job.blobs)
    .find((b) => b.blobId === blobId && b.status === 'preserved');
  if (!blob) return void res.status(404).json({ error: 'Not found' });
  const contentType = blob.contentType ?? '';
  if (!SERVABLE.test(contentType))
    return void res.status(415).json({ error: 'This file cannot be shown here' });

  const read = await readVerifiedEvidence(blob, readEvidenceObject, sha256Hex);
  if (!read.ok) return void res.status(502).json({ error: read.reason });

  await trackModActivity(user.id, {
    entityType: 'csamReport',
    entityId: reportId,
    activity: evidenceViewActivity(blobId),
  });

  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(read.bytes.length),
    'content-disposition': 'inline',
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  });
  res.end(Buffer.from(read.bytes));
}

export default ModEndpoint(handler);
