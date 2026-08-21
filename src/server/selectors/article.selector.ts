import { Prisma } from '@prisma/client';
import { imageSelect } from '~/server/selectors/image.selector';

import { getReactionsSelectV2 } from '~/server/selectors/reaction.selector';
import { simpleTagSelect } from '~/server/selectors/tag.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

// Shared select for article detail payloads. Intentionally omits
// `moderatorNsfwLevel` — this shape is reused by the outbound webhook job
// (`articleWebhooks` spreads `...article` into the third-party payload) and
// by the Meilisearch indexer (`articleSelect` spreads `...articleDetailSelect`
// into the index document), so anything exposed here leaks to external
// consumers. `moderatorNsfwLevel` is an internal moderation signal; callers
// that render the mod edit UI (`getArticleById`) extend this select explicitly
// with the override field instead.
export const articleDetailSelect = Prisma.validator<Prisma.ArticleSelect>()({
  id: true,
  createdAt: true,
  nsfwLevel: true,
  userNsfwLevel: true,
  content: true,
  cover: true,
  updatedAt: true,
  title: true,
  publishedAt: true,
  status: true,
  // `tag` is a required relation on TagsOnArticle, but orphaned join rows
  // exist in prod (tagId pointing at a hard-deleted Tag). Selecting the
  // required relation on such a row makes Prisma throw "Inconsistent query
  // result: Field tag is required ... got null" → HTTP 500 for every consumer
  // of this select (getArticleById, the search indexer,
  // the outbound webhook). Filtering on tag existence drops the orphan join
  // rows so these queries degrade gracefully instead of erroring.
  tags: { select: { tag: { select: simpleTagSelect } }, where: { tag: { is: {} } } },
  user: {
    select: { ...userWithCosmeticsSelect, isModerator: true },
  },
  reactions: {
    select: getReactionsSelectV2,
  },
  stats: {
    select: {
      viewCountAllTime: true,
      commentCountAllTime: true,
      likeCountAllTime: true,
      dislikeCountAllTime: true,
      heartCountAllTime: true,
      laughCountAllTime: true,
      cryCountAllTime: true,
      favoriteCountAllTime: true,
      tippedAmountCountAllTime: true,
      collectedCountAllTime: true,
    },
  },
  ingestion: true,
  availability: true,
  userId: true,
  coverImage: { select: imageSelect },
  lockedProperties: true,
  metadata: true,
});
