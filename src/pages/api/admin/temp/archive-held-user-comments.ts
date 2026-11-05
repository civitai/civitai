import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { archiveUserComments } from '~/server/services/csam.service-new';
import { HOLD_MARKER_VIEW, holdMarkerViewExists } from '~/server/services/legal-hold.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { legalHoldUserIdsSql } from '~/server/utils/legal-hold';
import { booleanString } from '~/utils/zod-helpers';

const schema = z.object({ dryRun: booleanString().default(true) });

/**
 * One-off, run once right after the deploy that stops holding comments: archives every comment of
 * each user a hold covered, so none is lost when a delete stops keeping it. Covers the users named on
 * a report that still holds and those with an active hold marker; one `comments.json` per user in
 * the CSAM bucket (see `archiveUserComments`).
 *
 *   GET /api/admin/temp/archive-held-user-comments?token=$WEBHOOK_TOKEN          (dry run: the users)
 *   ...&dryRun=false   writes the archives
 *
 * Safe to re-run: each run writes a new copy and replaces nothing.
 */
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });

  const markers = (await holdMarkerViewExists())
    ? Prisma.sql`UNION SELECT "userId"::text FROM ${Prisma.raw(`"${HOLD_MARKER_VIEW}"`)}`
    : Prisma.empty;
  const userIds = (
    await dbRead.$queryRaw<{ userId: string }[]>`
      SELECT DISTINCT "userId" FROM (${legalHoldUserIdsSql} ${markers}) held
      WHERE "userId" ~ '^[0-9]+$'
    `
  )
    .map((r) => Number(r.userId))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);

  if (parsed.data.dryRun)
    return res.status(200).json({ dryRun: true, users: userIds.length, userIds });

  const archived: Awaited<ReturnType<typeof archiveUserComments>>[] = [];
  const failed: { userId: number; error: string }[] = [];
  for (const userId of userIds) {
    try {
      archived.push(await archiveUserComments(userId));
    } catch (e) {
      failed.push({ userId, error: (e as Error).message });
    }
  }

  await logToAxiom({
    name: 'csam-report',
    type: failed.length ? 'error' : 'info',
    subType: 'held-comments-archive',
    archived,
    failed,
  });
  return res.status(failed.length ? 500 : 200).json({
    users: userIds.length,
    comments: archived.reduce((sum, a) => sum + a.comments, 0),
    archived,
    failed,
  });
});
