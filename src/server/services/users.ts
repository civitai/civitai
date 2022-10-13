import { prisma } from '../db/client';

export const getUsers = async () =>
  prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
    },
  });
