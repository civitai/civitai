import { Prisma } from '@prisma/client';
import { ToolSort } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { GetAllToolsSchema, ToolMetadata } from '~/server/schema/tool.schema';

export type ToolModel = AsyncReturnType<typeof getAllTools>['items'][number];
export async function getAllTools(input?: GetAllToolsSchema) {
  const { cursor, limit, sort, type, include } = input || {};
  const includeUnlisted = include?.includes('unlisted');

  const orderBy: Prisma.ToolFindManyArgs['orderBy'] = [{ supported: 'desc' }];
  if (sort === ToolSort.AZ) orderBy.push({ name: 'asc' });
  if (sort === ToolSort.ZA) orderBy.push({ name: 'desc' });
  if (sort === ToolSort.Newest) orderBy.push({ id: 'desc' });
  if (sort === ToolSort.Oldest) orderBy.push({ id: 'asc' });
  if (includeUnlisted) orderBy.shift();

  const tools = await dbRead.tool.findMany({
    select: {
      id: true,
      name: true,
      icon: true,
      type: true,
      priority: true,
      domain: true,
      company: true,
      description: true,
      metadata: true,
      supported: true,
      createdAt: true,
    },
    where: { type, enabled: true, unlisted: includeUnlisted ? undefined : false },
    cursor: cursor ? { id: cursor } : undefined,
    orderBy,
    take: limit ? limit + 1 : undefined,
  });

  let nextCursor: number | undefined;
  if (limit && tools.length > limit) {
    const nextItem = tools.pop();
    nextCursor = nextItem?.id;
  }

  return {
    items: tools.map(({ metadata, ...tool }) => ({
      ...tool,
      bannerUrl: (metadata as ToolMetadata)?.header,
    })),
    nextCursor,
  };
}

export async function getToolByName(name: string) {
  return dbRead.tool.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  });
}

export async function getToolByDomain(domain: string) {
  return dbRead.tool.findFirst({
    where: { domain },
    select: { id: true },
  });
}
