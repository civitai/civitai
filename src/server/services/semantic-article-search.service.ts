import { ArticleSort } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { SemanticArticleSearchInput } from '~/server/schema/semantic-article-search.schema';
import { getInfiniteArticlesSchema } from '~/server/schema/article.schema';
import { articleSemanticEligibleWhere } from '~/server/search-index/articles.search-index';
import { getArticles } from '~/server/services/article.service';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { getBrowsingSettingAddons } from '~/server/services/system-cache';
import {
  queryVerdictLevel,
  recordRefusal,
  resolveSemanticBrowsingLevel,
  semanticQueryRefusal,
  type QueryRefusal,
  type QueryStage,
  type QueryTracker,
} from '~/server/services/semantic-query-guard';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import {
  collectPage,
  resolveTagIds,
  resolveUserIds,
  searchServiceSource,
  type CandidateFilter,
  type CandidateSource,
  type Hydrate,
} from '~/server/services/semantic-search-client';
import { Flags } from '~/shared/utils/flags';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

/** One creator's articles shown on a page at most, so a prolific author cannot fill it. */
export const MAX_HITS_PER_USER = 3;

type HydratedArticle = Awaited<ReturnType<typeof getArticles>>['items'][number];

const searchServiceCandidates = searchServiceSource('articles', {
  notFoundMessage: 'Article not found',
});

export async function searchSemanticArticles({
  input,
  user,
  track,
  candidateSource = searchServiceCandidates,
}: {
  input: SemanticArticleSearchInput;
  user?: SessionUser;
  track?: QueryTracker;
  candidateSource?: CandidateSource;
}) {
  const none = { items: [] as HydratedArticle[], nextCursor: undefined, correctedQuery: undefined };
  let browsingLevel = resolveSemanticBrowsingLevel(input.browsingLevel, user);
  const [hidden, addonData, userIds, tagIds] = await Promise.all([
    getAllHiddenForUser({ userId: user?.id }),
    getBrowsingSettingAddons(),
    input.usernames?.length ? resolveUserIds(input.usernames) : undefined,
    input.tagNames?.length ? resolveTagIds(input.tagNames) : undefined,
  ]);
  // A named user or tag that does not exist can match nothing.
  if (userIds && !userIds.length) return none;
  if (tagIds && tagIds.length < new Set(input.tagNames).size) return none;
  const { disablePoi } = resolveBrowsingSettingsAddons(addonData, browsingLevel, {
    isModerator: user?.isModerator,
  });
  const refusalOf = async (text: string, stage: QueryStage) => {
    const refusal = await semanticQueryRefusal(text, {
      browsingLevel,
      disablePoi,
      isModerator: user?.isModerator,
    });
    recordRefusal(track, refusal, text, 'articles_semantic', stage);
    return refusal;
  };
  const refusal = await refusalOf(input.query, 'query');
  const verdictLevel = queryVerdictLevel(refusal, browsingLevel, user?.isModerator);
  if (verdictLevel === 'refuse') return none;
  browsingLevel = verdictLevel;

  const excludedUserIds = [
    ...new Set(
      [...hidden.hiddenUsers, ...hidden.blockedUsers, ...hidden.blockedByUsers].map((x) => x.id)
    ),
  ];
  const excludedTagIds = hidden.hiddenTags.filter((x) => x.hidden).map((x) => x.id);
  const filter: CandidateFilter = {
    gate: { kind: 'level', nsfwLevels: Flags.instanceToArray(browsingLevel) },
    tagIds,
    excludedTagIds,
    userIds,
    excludedUserIds,
  };

  // The search page's own rule first: Qdrant only proposes candidates, and a point can outlive
  // the article's eligibility (a ban changes no article row).
  const eligible = async (ids: number[]) =>
    new Set(
      (
        await dbRead.article.findMany({
          // A deleted owner too: deletion unindexes their articles, but not atomically.
          where: {
            id: { in: ids },
            ...articleSemanticEligibleWhere,
            user: { ...articleSemanticEligibleWhere.user, deletedAt: null },
          },
          select: { id: true },
        })
      ).map((a) => a.id)
    );

  const perUser = new Map<number, number>();
  let returned = 0;
  let hydrated = 0;
  const hydrate: Hydrate<HydratedArticle> = async (ids) => {
    const allowed = await eligible(ids);
    const visible = ids.filter((id) => allowed.has(id));
    if (!visible.length) return [];
    // The feed's fetch path then applies the viewer's view: browsing level, hidden users and
    // tags, privacy and publish state.
    const { items } = await getArticles({
      ...getInfiniteArticlesSchema.parse({
        ids: visible,
        limit: visible.length,
        sort: ArticleSort.Newest,
        period: MetricTimeframe.AllTime,
        browsingLevel,
        excludedUserIds,
        excludedTagIds,
      }),
      sessionUser: user,
      include: ['cosmetics'],
    });
    const byId = new Map(items.map((a) => [a.id, a]));
    const kept: HydratedArticle[] = [];
    // In rank order, so the cap keeps each creator's best matches.
    for (const id of visible) {
      const article = byId.get(id);
      // As the Meilisearch index: an article with no card image is not listed.
      if (!article?.coverImage) continue;
      const count = perUser.get(article.user.id) ?? 0;
      if (count >= MAX_HITS_PER_USER) continue;
      perUser.set(article.user.id, count + 1);
      kept.push(article);
    }
    hydrated += kept.length;
    return kept;
  };

  let correctedQuery: string | undefined;
  let correctedRefusal: QueryRefusal | undefined;
  const page = await collectPage({
    candidates: async (offset, limit) => {
      const result = await candidateSource({ query: { text: input.query }, filter, offset, limit });
      // The service embeds its spelling correction, not the text audited above.
      if (correctedRefusal === undefined && result.correctedQuery !== undefined)
        correctedRefusal =
          result.correctedQuery !== input.query &&
          (await refusalOf(result.correctedQuery, 'correction'));
      if (correctedRefusal) return [];
      correctedQuery ??= result.correctedQuery;
      returned += result.ids.length;
      return result.ids;
    },
    hydrate,
    offset: input.cursor ?? 0,
    limit: input.limit,
  });

  // Tells "empty after hydration" apart from "no matches".
  logToAxiom({
    type: 'info',
    name: 'semantic-article-search',
    returned,
    hydrated,
    shown: page.items.length,
  }).catch(() => undefined);

  if (correctedRefusal) return none;
  return { ...page, correctedQuery };
}
