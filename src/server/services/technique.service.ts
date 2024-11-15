import { dbRead } from '~/server/db/client';

export type TechniqueModel = AsyncReturnType<typeof getAllTechniques>[number];
export async function getAllTechniques() {
  return await dbRead.technique.findMany({
    select: {
      id: true,
      name: true,
      type: true,
    },
  });
}

export async function getTechniqueByName(name: string) {
  return dbRead.technique.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  });
}
