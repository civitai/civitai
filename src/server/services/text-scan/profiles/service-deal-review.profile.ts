import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import type { TextScanSubject } from '~/server/services/text-scan/types';

/**
 * A buyer's review of a service deal and the seller's one reply to it: two texts on one row, by two
 * authors, each scanned and held on its own. Keyed by the review's id.
 */
export const SERVICE_DEAL_REVIEW_TEXTS = {
  ServiceDealReview: {
    text: Prisma.raw('"comment"'),
    status: Prisma.raw('"scanStatus"'),
    workflow: Prisma.raw('"scanWorkflowId"'),
    author: Prisma.raw('"buyerId"'),
    heading: 'Review',
  },
  ServiceDealReviewReply: {
    text: Prisma.raw('"sellerReply"'),
    status: Prisma.raw('"sellerReplyScanStatus"'),
    workflow: Prisma.raw('"sellerReplyScanWorkflowId"'),
    author: Prisma.raw('"sellerId"'),
    heading: 'Seller reply',
  },
} as const;

export type ServiceDealReviewTextType = keyof typeof SERVICE_DEAL_REVIEW_TEXTS;

/**
 * Declared at the deal's level, so the scan reads the text against what the deal allows. A review
 * with no text of this kind is absent; a hidden one is not public.
 */
export const loadServiceDealReviewSubjects = async (
  type: ServiceDealReviewTextType,
  ids: number[]
): Promise<Map<number, TextScanSubject>> => {
  if (!ids.length) return new Map();
  const { text, author, heading } = SERVICE_DEAL_REVIEW_TEXTS[type];
  const rows = await dbWrite.$queryRaw<
    { id: number; userId: number; text: string; maxNsfwLevel: number; hidden: boolean }[]
  >`
    SELECT r."id", r.${author} AS "userId", r.${text} AS "text", d."maxNsfwLevel",
      r."hiddenAt" IS NOT NULL AS "hidden"
    FROM "ServiceDealReview" r JOIN "ServiceDeal" d ON d."id" = r."dealId"
    WHERE r."id" IN (${Prisma.join(ids)}) AND r.${text} IS NOT NULL`;
  return new Map(
    rows.map((r) => [
      r.id,
      {
        userId: r.userId,
        declared: { nsfwLevel: r.maxNsfwLevel },
        notPublic: r.hidden,
        fields: [{ heading, text: r.text }],
      },
    ])
  );
};

for (const entityType of Object.keys(SERVICE_DEAL_REVIEW_TEXTS) as ServiceDealReviewTextType[])
  registerTextScanProfile({
    entityType,
    labels: ['nsfw', 'csam'],
    load: (ids) => loadServiceDealReviewSubjects(entityType, ids),
  });
