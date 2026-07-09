import { Prisma } from '@prisma/client';
import { userWithCosmeticsSelect } from './user.selector';

export const getBountyDetailsSelect = Prisma.validator<Prisma.BountySelect>()({
  id: true,
  name: true,
  description: true,
  details: true,
  createdAt: true,
  type: true,
  expiresAt: true,
  startsAt: true,
  minBenefactorUnitAmount: true,
  mode: true,
  entryMode: true,
  entryLimit: true,
  nsfwLevel: true,
  nsfw: true,
  poi: true,
  complete: true,
  availability: true,
  lockedProperties: true,
  user: { select: userWithCosmeticsSelect },
  // where: { tag: { is: {} } } drops orphaned TagsOnBounty join rows (tagId → hard-deleted
  // Tag); the required `tag` relation would otherwise throw "Inconsistent query result" →
  // 500. Same class/fix as articleDetailSelect.
  tags: { select: { tag: { select: { id: true, name: true } } }, where: { tag: { is: {} } } },
  _count: {
    select: {
      entries: true,
    },
  },
  stats: {
    select: {
      favoriteCountAllTime: true,
      trackCountAllTime: true,
      entryCountAllTime: true,
      benefactorCountAllTime: true,
      unitAmountCountAllTime: true,
      commentCountAllTime: true,
    },
  },
});
