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

export async function getToolByName(name: string) {
  return dbRead.tool.findFirst({
    where: { name },
    select: { id: true },
  });
}

export async function getToolByDomain(domain: string) {
  return dbRead.tool.findFirst({
    where: { domain },
    select: { id: true },
  });
}
