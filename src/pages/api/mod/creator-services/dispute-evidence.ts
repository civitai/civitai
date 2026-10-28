import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { getServiceDisputeEvidence } from '~/server/services/creator-service-dispute-review.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('creatorServices.disputeEvidence', {
  method: 'GET',
  summary: 'Everything a dispute review reads for one Creator Services deal, in one bundle.',
  returns:
    '{ deal, offering: { id, title, description }, events, files: [{ id, kind, round, status, scanStatus, malwareScanStatus, failReason, fileName, mimeType, size, deliverySize, uploadedAt, access? }], accessRecordedSince, priorDisputes: { days, buyer, seller }, agentMode }',
  notes: [
    'Requires the moderator app permission `creatorServices.reviewDispute` or `creatorServices.resolveDispute`.',
    "`deal` carries the agreed terms (price, revisions, delivery days, preview kind, maximum NSFW level) and the buyer's `requestText`; `offering.description` is the listing as it reads now.",
    'Files carry no content hash: none is stored.',
    '`access` is per role and kind, as on deal-files; it is absent from every file when the access log could not be read, and `accessRecordedSince` is then null.',
    '`priorDisputes` counts the other deals each party was on, either side, whose dispute opened in the last `days` days.',
    "`agentMode` is the dispute agent's kill switch (`off`, `shadow`, `propose` or `settle`); a missing or unknown setting reads as `off`. The agent does nothing unless it allows what it is about to do.",
    "A moderator who is the deal's buyer or seller answers FORBIDDEN.",
  ],
  grantHolders: ['creatorServices.reviewDispute'],
  input: z.object({ dealId: z.coerce.number().int().positive() }),
  async handler({ dealId }, { actor }) {
    const [review, resolve] = await Promise.all([
      hasModeratorGrant(actor, 'creatorServices.reviewDispute'),
      hasModeratorGrant(actor, 'creatorServices.resolveDispute'),
    ]);
    if (!review && !resolve)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Reading dispute evidence needs the "creatorServices.reviewDispute" or "creatorServices.resolveDispute" moderator permission.',
      });
    return getServiceDisputeEvidence({ dealId, viewerId: actor.id });
  },
});
