import { dbRead } from '~/server/db/client';

export type ToolModel = AsyncReturnType<typeof getAllTools>[number];
export async function getAllTools() {
  return await dbRead.tool.findMany({
    select: {
      id: true,
      name: true,
      icon: true,
      type: true,
    },
  });
}
