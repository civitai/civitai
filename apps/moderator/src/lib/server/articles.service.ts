import { dbRead } from './db';
import { withheldRows } from './retracted-media';
import { ArticleStatus, type ArticleMetadata } from '$lib/articles';
import type { MediaType } from '$lib/media/edge-url';

const UNPUBLISHED: ArticleStatus[] = [
  ArticleStatus.Unpublished,
  ArticleStatus.UnpublishedViolation,
];

export type ModeratorArticleRow = {
  id: number;
  title: string;
  status: ArticleStatus;
  userId: number;
  createdAt: Date | null;
  publishedAt: Date | null;
  metadata: ArticleMetadata;
  coverId: number | null;
  coverUrl: string | null;
  coverType: MediaType | null;
  /** The cover is withheld from this moderator: no key and no type. */
  coverRestricted: boolean;
  username: string | null;
};

export async function getModeratorArticles({
  page = 1,
  limit = 20,
  username,
  status,
  viewer,
}: {
  page?: number;
  limit?: number;
  username?: string;
  status?: ArticleStatus;
  viewer: App.Locals['user'] | undefined;
}): Promise<{ items: ModeratorArticleRow[]; totalItems: number; page: number; limit: number }> {
  const offset = (page - 1) * limit;

  let base = dbRead
    .selectFrom('Article')
    .innerJoin('User', 'User.id', 'Article.userId')
    .leftJoin('Image', 'Image.id', 'Article.coverId')
    .where('Article.status', 'in', status ? [status] : UNPUBLISHED);
  if (username) base = base.where('User.username', 'ilike', `%${username}%`);

  const totalItems = Number(
    (await base.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirst())?.count ?? 0
  );

  const items = (await base
    .select([
      'Article.id',
      'Article.title',
      'Article.status',
      'Article.userId',
      'Article.createdAt',
      'Article.publishedAt',
      'Article.metadata',
      'Article.coverId',
      'Image.url as coverUrl',
      'Image.type as coverType',
      'User.username',
    ])
    .orderBy('Article.createdAt', 'desc')
    .limit(limit)
    .offset(offset)
    .execute()) as Omit<ModeratorArticleRow, 'coverRestricted'>[];

  return {
    items: await withheldRows(
      items.map((row) => ({ ...row, coverRestricted: false })),
      viewer,
      'articles-unpublished',
      (row) => row.coverId,
      (row) => ({ ...row, coverUrl: null, coverType: null, coverRestricted: true })
    ),
    totalItems,
    page,
    limit,
  };
}

export async function countModeratorArticles(): Promise<number> {
  const row = await dbRead
    .selectFrom('Article')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('status', 'in', UNPUBLISHED)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}
