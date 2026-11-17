import type { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { isDev } from '~/env/other';
import type { dbWrite } from '~/server/db/client';
import { getResourceIdsWithActiveAccessTokens } from '~/server/services/access-token.service';
import { isShareableArticleStatus } from '~/server/services/text-scan/public-content';
import type { ArticleStatus } from '~/shared/utils/prisma/enums';

/** Draft or Unpublished with a share link that still grants access. */
export async function isSharedArticle(
  id: number,
  status: ArticleStatus,
  db?: Prisma.TransactionClient | typeof dbWrite
) {
  return (
    isShareableArticleStatus(status) &&
    (await getResourceIdsWithActiveAccessTokens('Article', [id], db)).has(id)
  );
}

/** Identifies the text a shared draft's check covers. */
export function sharedArticleTextHash({
  title,
  content,
}: {
  title: string | null;
  content: string | null;
}) {
  return createHash('sha256')
    .update(`${title ?? ''}\u0000${content ?? ''}`)
    .digest('hex');
}

/**
 * One cookie per article, so opening a second link keeps the first. `__Host-` (Secure, Path=/, no
 * Domain) stops a subdomain from setting it; plain http in development cannot carry the prefix.
 */
export const articleShareCookieName = (articleId: number) =>
  `${isDev ? '' : '__Host-'}civ-article-share-${articleId}`;
