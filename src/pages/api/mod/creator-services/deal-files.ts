import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import {
  getServiceDealFileAccessRecordedSince,
  listServiceDealFileAccess,
  listServiceDealFiles,
} from '~/server/services/creator-service-deal-file.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const MAX_DEALS = 25;

/** Fails open: the file list a dispute needs must not depend on the access log. */
async function readAccess(dealIds: number[]) {
  try {
    const [rows, recordedSince] = await Promise.all([
      listServiceDealFileAccess(dealIds),
      getServiceDealFileAccessRecordedSince(),
    ]);
    return { rows, recordedSince };
  } catch (error) {
    logToAxiom({
      name: 'creator-service-file-access',
      type: 'error',
      message: 'Could not read deal file accesses',
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => null);
    return null;
  }
}

export default defineModeratorEndpoint('creatorServices.dealFiles', {
  method: 'GET',
  summary: 'Every delivery file of one or more Creator Services deals, for dispute review.',
  returns: '{ items, accessRecordedSince }',
  notes: [
    'Pass `dealId` for one deal, or `dealIds` (comma separated, at most 25) for a page of them in one call. Each item carries its `dealId`; a deal that does not exist contributes no items.',
    'A moderator sees every file, including previews that failed processing and finals that have not passed their scan.',
    'Get a short-lived download link for one with GET /api/mod/creator-services/deal-file-url (the original, not the watermarked preview).',
    '`previewUrl` is the watermarked derivative a buyer sees. Null until the preview is Ready.',
    '`access` lists who has been handed a download link for the file: one entry per role on the deal (Buyer, Seller, or Moderator for a non-party) and kind (Download through the site, ModeratorFetch through deal-file-url), with `count`, `firstAt` and `lastAt`. Empty if nobody has; absent if the access log could not be read.',
    '`accessRecordedSince` is when the first access was recorded (null if none yet). Nothing before it was recorded, so an empty `access` on a deal completed earlier proves nothing.',
  ],
  input: z.object({
    dealId: z.coerce.number().int().positive().optional().describe('One deal id.'),
    dealIds: z
      .string()
      .optional()
      .describe(`Comma separated deal ids, at most ${MAX_DEALS}. Use instead of dealId.`),
  }),
  async handler({ dealId, dealIds }, { actor }) {
    const ids = new Set<number>();
    if (dealId) ids.add(dealId);
    for (const part of dealIds?.split(',') ?? []) {
      const id = Number(part.trim());
      if (!Number.isInteger(id) || id <= 0)
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Not a deal id: ${part}` });
      ids.add(id);
    }
    if (!ids.size) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Pass dealId or dealIds.' });
    if (ids.size > MAX_DEALS)
      throw new TRPCError({ code: 'BAD_REQUEST', message: `At most ${MAX_DEALS} deals per call.` });

    const [perDeal, access] = await Promise.all([
      Promise.all(
        [...ids].map(async (id) => {
          try {
            const files = await listServiceDealFiles({
              dealId: id,
              userId: actor.id,
              isModerator: true,
            });
            return files.map((file) => ({ dealId: id, ...file }));
          } catch (error) {
            // A deal that is not there has no files; anything else is a real failure.
            if (error instanceof TRPCError && error.code === 'NOT_FOUND') return [];
            throw error;
          }
        })
      ),
      readAccess([...ids]),
    ]);
    return {
      items: perDeal.flat().map((file) => ({
        ...file,
        ...(access && {
          access: access.rows
            .filter((a) => a.fileId === file.id)
            .map(({ role, kind, count, firstAt, lastAt }) => ({
              role,
              kind,
              count,
              firstAt,
              lastAt,
            })),
        }),
      })),
      accessRecordedSince: access?.recordedSince ?? null,
    };
  },
});
