import { dbRead } from '~/server/db/client';
import { shuffle } from '~/utils/array-helpers';

export const getAllPartners = async () => {
  const partners = await dbRead.partner.findMany({
    where: {},
    select: {
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
      tier: true,
      logo: true,
      // createdAt: true,
    },
  });

  return shuffle(partners);
};
