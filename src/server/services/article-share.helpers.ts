import type { Prisma } from '@prisma/client';
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
