import { Prisma } from '@prisma/client';
import { dbRead } from '../db/client';

export const getAllBenefactorsByBountyId = ({
  input,
  select,
}: {
  input: { bountyId: number };
  select: Prisma.BountyBenefactorSelect;
}) => {
  return dbRead.bountyBenefactor.findMany({
    where: { bountyId: input.bountyId },
    select,
  });
};
