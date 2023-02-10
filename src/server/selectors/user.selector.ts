import { Prisma } from '@prisma/client';

export const simpleUserSelect = Prisma.validator<Prisma.UserSelect>()({
  id: true,
  username: true,
  deletedAt: true,
  image: true,
});

const simpleUser = Prisma.validator<Prisma.UserArgs>()({
  select: simpleUserSelect,
});

export type SimpleUser = Prisma.UserGetPayload<typeof simpleUser>;

export const userWithCosmeticsSelect = Prisma.validator<Prisma.UserSelect>()({
  ...simpleUserSelect,
  cosmetics: {
    where: { equippedAt: { not: null } },
    select: {
      cosmetic: {
        select: {
          id: true,
          data: true,
          type: true,
          source: true,
          name: true,
        },
      },
    },
  },
});

const userWithCosmetics = Prisma.validator<Prisma.UserArgs>()({
  select: userWithCosmeticsSelect,
});

export type UserWithCosmetics = Prisma.UserGetPayload<typeof userWithCosmetics>;
