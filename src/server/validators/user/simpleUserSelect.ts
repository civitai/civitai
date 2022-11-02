import { Prisma } from '@prisma/client';

export const simpleUserSelect = Prisma.validator<Prisma.UserSelect>()({
  id: true,
  username: true,
  name: true,
  image: true,
});

const simpleUser = Prisma.validator<Prisma.UserArgs>()({
  select: simpleUserSelect,
});

export type SimpleUser = Prisma.UserGetPayload<typeof simpleUser>;
