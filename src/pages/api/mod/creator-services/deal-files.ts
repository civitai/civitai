import * as z from 'zod';
import { listServiceDealFiles } from '~/server/services/creator-service-deal-file.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('creatorServices.dealFiles', {
  method: 'GET',
  summary: 'Every delivery file of one Creator Services deal, for dispute review.',
  returns: '{ items }',
  notes: [
    'A moderator sees every file, including previews that failed processing and finals that have not passed their scan.',
    'Download one with GET /api/service-deals/files/{id}/download (a redirect to a short-lived signed URL; the original, not the watermarked preview).',
    '`previewUrl` is the watermarked derivative a buyer sees. Null until the preview is Ready.',
  ],
  input: z.object({
    dealId: z.coerce.number().int().positive().describe('The deal id.'),
  }),
  async handler({ dealId }, { actor }) {
    const items = await listServiceDealFiles({ dealId, userId: actor.id, isModerator: true });
    return { items };
  },
});
