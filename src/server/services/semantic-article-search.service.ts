import type { ManipulateType } from 'dayjs';
import { ArticleSort } from '~/server/common/enums';
import { getUserFollows } from '~/server/redis/caches';
import dayjs from '~/shared/utils/dayjs';
import { decreaseDate } from '~/utils/date-helpers';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { SemanticArticleSearchInput } from '~/server/schema/semantic-article-search.schema';
import { getInfiniteArticlesSchema } from '~/server/schema/article.schema';
import { articleSemanticEligibleWhere } from '~/server/search-index/articles.search-index';
import { getArticles } from '~/server/services/article.service';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { getBrowsingSettingAddons } from '~/server/services/system-cache';
import {
  beginSemanticAudit,
  isNonModClampOn,
  makeRefusalOf,
  type QueryTracker,
  queryVerdictLevel,
  refusedTextCandidates,
  resolveSemanticBrowsingLevel,
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
import { ArticleEngagementType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

export { MAX_HITS_PER_USER };

type HydratedArticle = Awaited<ReturnType<typeof getArticles>>['items'][number];

// Most followed creators sent to the index as a user filter; past it, hydration alone applies Followed.
const MAX_INDEXED_FOLLOWS = 1000;
// Most articles of the viewer's own list (bookmarks, hidden, a collection) sent to the index as an
// id filter; past it, hydration alone applies the list.
const MAX_INDEXED_LIST_IDS = 1000;

// The articles in the viewer's Bookmarked or Hidden view (Bookmarked wins, as in getArticles) and
// in the feed's collection, intersected; undefined when no list applies or each is past the cap.
// A superset is safe: hydration still applies each list's own rule (collection read access, item
// status), so this only keeps the ranking within the list.
async function listedArticleIds(
  input: Pick<SemanticArticleSearchInput, 'favorites' | 'hidden' | 'collectionId'>,
  userId: number | undefined
) {
  const engagement =
    userId && input.favorites
      ? ArticleEngagementType.Favorite
      : userId && input.hidden
      ? ArticleEngagementType.Hide
      : undefined;
  const take = MAX_INDEXED_LIST_IDS + 1;
  const [engaged, collected] = await Promise.all([
    engagement &&
      dbRead.articleEngagement
        .findMany({ where: { userId, type: engagement }, select: { articleId: true }, take })
        .then((rows) => rows.map((r) => r.articleId)),
    input.collectionId &&
      dbRead.collectionItem
        .findMany({
          where: { collectionId: input.collectionId, articleId: { not: null } },
          select: { articleId: true },
          take,
        })
        .then((rows) => rows.map((r) => r.articleId as number)),
  ]);
  const lists = [engaged, collected].filter(
    (ids): ids is number[] => !!ids && ids.length <= MAX_INDEXED_LIST_IDS
  );
  if (!lists.length) return undefined;
  return lists.reduce((acc, ids) => {
    const listed = new Set(ids);
    return acc.filter((id) => listed.has(id));
  });
}

// The feed's period as a published-since bound. Truncated to the hour so the cached candidates'
// key, which carries the filter, holds still between requests.
function publishedSince(period: MetricTimeframe | undefined) {
  if (!period || period === MetricTimeframe.AllTime) return undefined;
  const hour = dayjs().startOf('hour').toDate();
  return decreaseDate(hour, 1, period.toLowerCase() as ManipulateType).toISOString();
}

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
    await isNonModClampOn(user)
  );
  const [hidden, addonData, namedUserIds, namedTagIds, follows, listedIds] = await Promise.all([
    getAllHiddenForUser({ userId: user?.id }),
    getBrowsingSettingAddons(),
    input.usernames?.length ? resolveUserIds(input.usernames) : undefined,
    input.tagNames?.length ? resolveTagIds(input.tagNames) : undefined,
    input.followed && user ? getUserFollows(user.id) : undefined,
    listedArticleIds(input, user?.id),
  ]);
  // Followed narrows the ranking itself, so a short follow list doesn't leave a page of misses.
  const followedIds = follows && follows.length <= MAX_INDEXED_FOLLOWS ? follows : undefined;
  const userIds =
    namedUserIds && followedIds
      ? namedUserIds.filter((id) => followedIds.includes(id))
      : namedUserIds ?? followedIds;
  // Matches nothing: any unknown tag; usernames none of which exist (or none followed); an empty list.
  // An unknown username among known ones is dropped.
  if (userIds && !userIds.length) return none;
  if (listedIds && !listedIds.length) return none;
  if (namedTagIds && namedTagIds.length < new Set(input.tagNames).size) return none;
  const tagIds =
    namedTagIds || input.tagIds?.length
      ? [...new Set([...(namedTagIds ?? []), ...(input.tagIds ?? [])])]
      : undefined;
  const addonsFor = (level: number) =>
    resolveBrowsingSettingsAddons(addonData, level, { isModerator: user?.isModerator });
  let addons = addonsFor(browsingLevel);
  const audit = beginSemanticAudit({
    index: 'articles',
    viewer: user,
    query: input.query,
    firstPage: !input.cursor,
  });
  const refusalOf = makeRefusalOf({
    index: 'articles_semantic',
    track,
    context: () => ({
      browsingLevel,
      disablePoi: addons.disablePoi,
      isModerator: user?.isModerator,
    }),
    audit,
  });
  const refusal = await refusalOf(input.query, 'query');
  const verdictLevel = queryVerdictLevel(refusal, browsingLevel, user?.isModerator);
  const queryRefused = verdictLevel === 'refuse';
  if (!queryRefused && verdictLevel !== browsingLevel) {
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
    ids: listedIds,
    excludedUserIds,
    range: { key: 'publishedAt', gte: publishedSince(input.period) },
  };
  // Refused before any search: the audit may run it after the response, for its row only.
  if (queryRefused)
    return audit.refused(
      none,
      browsingLevel,
      refusedTextCandidates(candidateSource, {
        text: input.query,
        filter,
        viewer: { isModerator: !!user?.isModerator },
      })
    );

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
        // The feed's views of the viewer's own lists; the index can't apply them.
        followed: input.followed,
        favorites: input.favorites,
        hidden: input.hidden,
        collectionId: input.collectionId,
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
    viewer: { isModerator: !!user?.isModerator },
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
    hydrated,
    payload: { returned: search.state.returned, shown: page.items.length },
  });

  audit.candidates(search.state.first);
  if (search.state.refused)
    return audit.refused(none, browsingLevel, async () => search.state.first ?? { ids: [] });
  return audit.done({ ...page, correctedQuery: search.state.correctedQuery }, browsingLevel);
}
