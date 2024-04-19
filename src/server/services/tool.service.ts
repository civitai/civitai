import { dbRead } from '~/server/db/client';

export async function getAllTools() {
  return await dbRead.tool.findMany({
    select: {
      id: true,
      name: true,
      icon: true,
    },
  });
}
