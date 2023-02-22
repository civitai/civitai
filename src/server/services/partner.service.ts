import { Prisma } from '@prisma/client';
import { dbWrite, dbRead } from '~/server/db/client';

export const getAllPartners = async <TSelect extends Prisma.PartnerSelect>(args?: {
  select?: TSelect;
}) => {
  const { select } = args ?? {};
  return dbRead.partner.findMany({
    where: {},
    select: select ?? {
      id: true,
      name: true,
      homepage: true,
      tos: true,
      privacy: true,
      startupTime: true,
      stepsPerSecond: true,
      pricingModel: true,
      price: true,
      onDemand: true,
      about: true,
      // createdAt: true,
    },
  });
};
