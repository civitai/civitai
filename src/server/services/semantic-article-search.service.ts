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
  isNonModClampOn,
  resolveSemanticBrowsingLevel,
  semanticQueryRefusal,
  type QueryStage,
  type QueryTracker,
} from '~/server/services/semantic-query-guard';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import {
  MAX_HITS_PER_USER,
  collectPage,
  resolveTagIds,
  resolveUserIds,
  searchServiceSource,
  type CandidateFilter,
  type CandidateSource,
  type Hydrate,
  auditedTextCandidates,
  viewerExcludedUserIds,
} from '~/server/services/semantic-search-client';
import { Flags } from '~/shared/utils/flags';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

export { MAX_HITS_PER_USER };

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
  let browsingLevel = resolveSemanticBrowsingLevel(
    input.browsingLevel,
    user,
    await isNonModClampOn()
  );
  const [hidden, addonData, userIds, tagIds] = await Promise.all([
    getAllHiddenForUser({ userId: user?.id }),
    getBrowsingSettingAddons(),
    input.usernames?.length ? resolveUserIds(input.usernames) : undefined,
    input.tagNames?.length ? resolveTagIds(input.tagNames) : undefined,
  ]);
  // A named user or tag that does not exist can match nothing.
  if (userIds && !userIds.length) return none;
  if (tagIds && tagIds.length < new Set(input.tagNames).size) return none;
  const addonsFor = (level: number) =>
    resolveBrowsingSettingsAddons(addonData, level, { isModerator: user?.isModerator });
  let addons = addonsFor(browsingLevel);
  const refusalOf = async (text: string, stage: QueryStage) => {
    const refusal = await semanticQueryRefusal(text, {
      browsingLevel,
      disablePoi: addons.disablePoi,
      isModerator: user?.isModerator,
    });
    recordRefusal(track, refusal, text, 'articles_semantic', stage);
    return refusal;
  };
  const refusal = await refusalOf(input.query, 'query');
  const verdictLevel = queryVerdictLevel(refusal, browsingLevel, user?.isModerator);
  if (verdictLevel === 'refuse') return none;
  if (verdictLevel !== browsingLevel) {
    browsingLevel = verdictLevel;
    addons = addonsFor(browsingLevel);
  }

  const excludedUserIds = viewerExcludedUserIds(hidden);
  const excludedTagIds = [
    ...new Set([
      ...addons.excludedTagIds,
      ...hidden.hiddenTags.filter((x) => x.hidden).map((x) => x.id),
    ]),
  ];
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

  const search = auditedTextCandidates({
    source: candidateSource,
    text: input.query,
    filter,
    audit: (correction) => refusalOf(correction, 'correction'),
  });
  const page = await collectPage({
    candidates: search.candidates,
    hydrate,
    offset: input.cursor ?? 0,
    limit: input.limit,
  });

  // Tells "empty after hydration" apart from "no matches".
  logToAxiom({
    type: 'info',
    name: 'semantic-article-search',
    returned: search.state.returned,
    hydrated,
    shown: page.items.length,
  }).catch(() => undefined);

  if (search.state.refused) return none;
  return { ...page, correctedQuery: search.state.correctedQuery };
}
