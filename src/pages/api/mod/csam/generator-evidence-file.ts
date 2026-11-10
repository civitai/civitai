import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import {
  EVIDENCE_MEDIA_TYPES,
  isGeneratorEvidenceDetails,
} from '~/server/services/generator-evidence/evidence-meta';
import { readVerifiedEvidence } from '~/server/services/generator-evidence/evidence-payload';
import { streamEvidenceObject } from '~/server/services/generator-evidence/evidence-store';
import { evidenceViewActivity } from '~/server/services/generator-evidence/evidence-views';
import { trackModActivity } from '~/server/services/moderator.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import type { SessionUser } from '~/types/session';

export const config = { api: { responseLimit: false } };

const query = z.object({
  reportId: z.coerce.number().int().positive().max(2_147_483_647),
  blobId: z.string().min(1).max(200),
});

/** Larger files are not loaded into a web process to be shown; they are still sent. */
const MAX_VIEW_BYTES = 64 * 1024 * 1024;

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
  const contentType = blob.contentType?.toLowerCase() ?? '';
  if (!EVIDENCE_MEDIA_TYPES.has(contentType))
    return void res.status(415).json({ error: 'This file cannot be shown here' });
  const tooLarge = () =>
    void res.status(413).json({ error: 'This file is too large to show here' });
  if (blob.bytes !== undefined && blob.bytes > MAX_VIEW_BYTES) return tooLarge();

  const read = await readVerifiedEvidence(blob, streamEvidenceObject, MAX_VIEW_BYTES);
  if (!read.ok && read.overLimit) return tooLarge();
  if (!read.ok) {
    console.error('[generator-evidence-file] read refused', read.reason);
    return void res.status(502).json({ error: 'The preserved copy could not be read' });
  }

  await trackModActivity(user.id, {
    entityType: 'csamReport',
    entityId: reportId,
    activity: evidenceViewActivity(blobId),
  });

  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(read.body.size),
    'content-disposition': 'inline',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    'cache-control': 'private, no-store',
  });
  await pipeline(Readable.fromWeb(read.body.stream() as NodeReadableStream), res);
}

export default ModEndpoint(handler);
