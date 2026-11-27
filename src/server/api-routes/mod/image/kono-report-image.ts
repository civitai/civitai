import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { createReport } from '~/server/services/report.service';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';

const KNIGHTS_REPORT_VIOLATION = 'Knights players reported this image';

// The caller names the image only: reason, details and reporter are fixed here.
const schema = z.object({ imageId: z.number().int().positive() }).strict();

// Knights files this when its players pull an image, token-authenticated, server to server.
// Idempotent per image: once this route has filed on an image, a repeat call returns that report
// unchanged, whatever a moderator has since done with it.
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { imageId } = parsed.data;

  const image = await dbRead.image.findUnique({ where: { id: imageId }, select: { id: true } });
  if (!image) return res.status(404).json({ error: 'Image not found' });

  // The lock makes look-up-and-file one step, so two calls for one image cannot both file.
  const outcome = await withDistributedLock(
    { key: `knights:report-image:${imageId}`, ttl: 30, maxRetries: 20, autoRenew: true },
    async () => {
      // primary: a report filed a moment ago must be seen, or a retry files a second one.
      const open = await dbWrite.report.findFirst({
        where: {
          reason: ReportReason.TOSViolation,
          userId: constants.system.user.id,
          image: { imageId },
          details: { path: ['violation'], equals: KNIGHTS_REPORT_VIOLATION },
        },
        select: { id: true },
        orderBy: { id: 'desc' },
      });
      if (open) return { reportId: open.id, created: false };

      // Joins a report still waiting for a moderator, as the system's other filings do.
      const report = await createReport({
        type: ReportEntity.Image,
        id: imageId,
        userId: constants.system.user.id,
        isModerator: true,
        reason: ReportReason.TOSViolation,
        foldIntoPendingOnly: true,
        details: { violation: KNIGHTS_REPORT_VIOLATION },
      });
      // A fold returns someone else's report, or adds the system user to one it filed elsewhere.
      const created =
        report.userId === constants.system.user.id &&
        !report.alsoReportedBy.includes(constants.system.user.id);
      return { reportId: report.id, created };
    }
  );

  // Lock not acquired: another filing for this image is in flight. The caller retries.
  if (outcome === null) return res.status(503).json({ error: 'Report in progress' });
  return res.status(200).json(outcome);
});
