import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';

/** One community image featured in one model version's showcase, on one or both sites. */
export type FeaturedImageRow = {
  imageId: number;
  imageUrl: string;
  imageType: string;
  nsfwLevel: number;
  authorId: number;
  author: string | null;
  modelId: number;
  modelName: string;
  modelVersionId: number;
  versionName: string;
  /** 'com' and/or 'red'. */
  sites: string[];
  featuredBy: string | null;
  featuredAt: Date;
  /** Removed by its author or a moderator: the creator can't feature it again. */
  removed: boolean;
};

export type FeaturedImageFilters = {
  imageId?: number;
  modelId?: number;
  /** The image's author. */
  author?: string;
  /** Show removed ones too. */
  includeRemoved?: boolean;
  limit: number;
};

/** Community images creators featured in their model showcases, newest first. */
export async function listFeaturedImages(filters: FeaturedImageFilters) {
  let query = dbRead
    .selectFrom('ModelVersionShowcaseItem as s')
    .innerJoin('Image as i', 'i.id', 's.imageId')
    .innerJoin('ModelVersion as mv', 'mv.id', 's.modelVersionId')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .leftJoin('User as author', 'author.id', 'i.userId')
    .leftJoin('User as adder', 'adder.id', 's.addedById')
    .where('s.source', '=', 'Community')
    .select([
      's.imageId',
      'i.url as imageUrl',
      'i.type as imageType',
      'i.nsfwLevel',
      'i.userId as authorId',
      'author.username as author',
      'm.id as modelId',
      'm.name as modelName',
      's.modelVersionId',
      'mv.name as versionName',
      sql<string[]>`array_agg(s.site ORDER BY s.site)`.as('sites'),
      sql<string | null>`max(adder.username)`.as('featuredBy'),
      sql<Date>`min(s."createdAt")`.as('featuredAt'),
      sql<boolean>`bool_or(s.removed)`.as('removed'),
    ])
    .groupBy([
      's.imageId',
      'i.url',
      'i.type',
      'i.nsfwLevel',
      'i.userId',
      'author.username',
      'm.id',
      'm.name',
      's.modelVersionId',
      'mv.name',
    ]);
  if (filters.imageId) query = query.where('s.imageId', '=', filters.imageId);
  if (filters.modelId) query = query.where('m.id', '=', filters.modelId);
  if (filters.author) query = query.where('author.username', '=', filters.author);
  if (!filters.includeRemoved) query = query.having(sql<boolean>`NOT bool_or(s.removed)`);

  const rows = await query
    .orderBy(sql`min(s."createdAt")`, 'desc')
    .limit(filters.limit + 1)
    .execute();
  return {
    items: rows.slice(0, filters.limit) as FeaturedImageRow[],
    hasMore: rows.length > filters.limit,
  };
}
