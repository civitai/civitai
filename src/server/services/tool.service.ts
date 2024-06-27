import { dbRead } from '~/server/db/client';
import { ToolMetadata } from '~/server/schema/tool.schema';

export type ToolModel = AsyncReturnType<typeof getAllTools>[number];
export async function getAllTools() {
  const tools = await dbRead.tool.findMany({
    select: {
      id: true,
      name: true,
      icon: true,
      type: true,
      priority: true,
      domain: true,
      description: true,
      metadata: true,
    },
    where: { enabled: true },
  });

  return tools.map((t) => ({
    ...t,
    metadata: (t.metadata || {}) as ToolMetadata,
  }));
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
