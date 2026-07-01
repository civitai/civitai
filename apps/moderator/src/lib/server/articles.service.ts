import { dbRead } from './db';
import { ArticleStatus, type ArticleMetadata } from '$lib/articles';

const UNPUBLISHED: ArticleStatus[] = [ArticleStatus.Unpublished, ArticleStatus.UnpublishedViolation];

export type ModeratorArticleRow = {
  id: number;
  title: string;
  status: ArticleStatus;
  createdAt: Date | null;
  publishedAt: Date | null;
  metadata: ArticleMetadata;
  coverUrl: string | null;
  username: string | null;
  userImage: string | null;
};

export async function getModeratorArticles({
  page = 1,
  limit = 20,
  username,
  status,
}: {
  page?: number;
  limit?: number;
  username?: string;
  status?: ArticleStatus;
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
      'Article.createdAt',
      'Article.publishedAt',
      'Article.metadata',
      'Image.url as coverUrl',
      'User.username',
      'User.image as userImage',
    ])
    .orderBy('Article.createdAt', 'desc')
    .limit(limit)
    .offset(offset)
    .execute()) as ModeratorArticleRow[];

  return { items, totalItems, page, limit };
}
