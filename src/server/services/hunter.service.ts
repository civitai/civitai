import { prisma } from '~/server/db/client';
import { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';

export const getHunters = ({ limit, query, page }: GetAllSchema) => {
  return prisma.bounty.findMany();
};

export const createHunter = ({ data }: any) => {
  return prisma.bounty.create({ data });
};

export const updateHunterById = ({ id = -1, data }: any) => {
  return prisma.bounty.update({ where: { id }, data });
};

export const deleteHunterById = ({ id }: GetByIdInput) => {
  return prisma.bounty.delete({ where: { id } });
};
