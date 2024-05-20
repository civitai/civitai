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
