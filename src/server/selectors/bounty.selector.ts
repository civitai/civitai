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
  user: { select: userWithCosmeticsSelect },
  tags: { select: { tag: { select: { id: true, name: true } } } },
  nsfw: true,
  complete: true,
});
