import { BlocklistType } from '~/server/common/enums';
import { getEffectiveBrowsingLevel } from '~/server/games/daily-challenge/challenge-visibility';
import type { Tracker } from '~/server/clickhouse/tracker';
import { stripBenignPhrases } from '~/server/services/blocklist.service';
import { matchesQueryRule } from '~/server/services/search-query-rules';
import {
  allBrowsingLevelsFlag,
  nsfwBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  ensureFliptInitialized,
  FLIPT_FEATURE_FLAGS,
  getFliptClientSync,
  getFliptLocalOverride,
} from '~/server/flipt/client';
import { countQueryVerdict } from '~/server/metrics/semantic-search.metrics';
import {
  AUDIT_RESULT_IDS,
  recordRefusedSemanticAudit,
  recordSemanticAudit,
  verdictComputesRefusedIds,
  verdictKeepsServedIds,
  type RefusedSearchPath,
  type SemanticSearchPath,
  type RefusedCandidates,
  type SemanticAuditEntry,
} from '~/server/services/semantic-search-audit.service';
import {
  GUARD_NONE,
  type CandidateFilter,
  type CandidateSource,
  type GuardRead,
  type SearchViewer,
  type SearchCollection,
} from '~/server/services/semantic-search-client';
import { getBrowsingSettingAddons } from '~/server/services/system-cache';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';
import {
  includesInappropriate,
  includesMinor,
  includesNsfw,
  includesPoi,
} from '~/utils/metadata/audit';
import { getBlockedNsfwWords } from '~/utils/metadata/audit-base';

export type QueryTracker = Pick<Tracker, 'action'>;
export type QueryRefusal =
  | 'minor'
  | 'minor-safe'
  | 'poi'
  | 'poi-minor'
  | 'blocked'
  | 'error'
  | false;

/**
 * The viewer's own level; while `clamp` (the containment switch) is on, non-moderators get the safe
 * levels. Only an explicit `false` lifts it: pass `await isNonModClampOn(user)`.
 */
export function resolveSemanticBrowsingLevel(
  requested: number | undefined,
  user: SessionUser | undefined,
  clamp: boolean | undefined
) {
  const level = requested || publicBrowsingLevelsFlag;
  if (user?.isModerator || clamp === false) return level;
  return Flags.intersection(level, sfwBrowsingLevelsFlag) || publicBrowsingLevelsFlag;
}

/**
 * The containment switch, read fail-closed: only a successful evaluation that answers off lifts
 * the clamp. An unavailable client, an evaluation error (a missing key throws) or a malformed
 * answer all hold it. Read uncached so a flip takes effect at the next refresh. Evaluated per
 * viewer (`userId` in the context; signed out has none), so a segment can lift it for one account.
 */
export async function isNonModClampOn(
  viewer: Pick<SessionUser, 'id'> | undefined
): Promise<boolean> {
  const flag = FLIPT_FEATURE_FLAGS.SEMANTIC_SEARCH_NONMOD_CLAMP;
  const override = getFliptLocalOverride(flag);
  if (override !== undefined) return override !== 'off';
  await ensureFliptInitialized();
  const client = getFliptClientSync();
  if (!client) return true;
  try {
    return (
      client.evaluateBoolean({
        flagKey: flag,
        entityId: viewer ? String(viewer.id) : 'global',
        context: viewer ? { userId: String(viewer.id) } : {},
      }).enabled !== false
    );
  } catch (e) {
    const now = Date.now();
    if (now - lastClampEvalErrorLog > 60_000) {
      lastClampEvalErrorLog = now;
      console.error(`[flipt] ${flag} could not be evaluated; holding the clamp`, e);
    }
    return true;
  }
}
let lastClampEvalErrorLog = 0;

/**
 * "More like this" never rates above its anchor: the viewer's levels at or below the anchor's.
 * An anchor with no usable level falls back to the safe levels, never the viewer's full range.
 */
export function anchorBrowsingLevel(viewerLevel: number, anchorNsfwLevel: number | undefined) {
  const atOrBelow = anchorNsfwLevel
    ? Flags.arrayToInstance(Flags.instanceToArray(viewerLevel).filter((l) => l <= anchorNsfwLevel))
    : 0;
  return (
    atOrBelow || Flags.intersection(viewerLevel, sfwBrowsingLevelsFlag) || publicBrowsingLevelsFlag
  );
}

/** The search gates' query audit, run on the server; any failure refuses. */
export async function semanticQueryRefusal(
  query: string,
  {
    browsingLevel,
    disablePoi,
    isModerator,
  }: { browsingLevel: number; disablePoi: boolean; isModerator?: boolean }
): Promise<QueryRefusal> {
  try {
    const audited = await stripBenignPhrases(query, BlocklistType.PromptBenignPhrase);
    // The raw text decides whether the person and age checks run; the stripped text is what they read.
    const nsfw = Flags.intersects(browsingLevel, nsfwBrowsingLevelsFlag) || !!includesNsfw(query);
    const verdict = includesInappropriate({ prompt: audited }, nsfw);
    if (verdict === 'minor') return 'minor';
    // A 'poi' verdict is returned before the minor check runs, so it can hide one; still refused.
    if (verdict && includesMinor(audited)) return 'poi-minor';
    if (verdict) return verdict;
    if ((disablePoi || !isModerator) && includesPoi(audited)) return 'poi';
    // Raw text: the benign phrases do not carve out this list.
    if (!isModerator && getBlockedNsfwWords(query).length) return 'blocked';
    // Mods are exempt from the POI additions even with `disablePoi`, by design. A minor addition is
    // its own verdict, so the help event and its counts stay the minor list's.
    const [poiRule, minorRule] = await Promise.all([
      !isModerator && matchesQueryRule(audited, BlocklistType.SemanticSearchPoiRefuse),
      matchesQueryRule(audited, BlocklistType.SemanticSearchMinorSafe),
    ]);
    if (poiRule) return 'poi';
    if (minorRule) return 'minor-safe';
    return false;
  } catch {
    return 'error';
  }
}

/**
 * What a raw-query verdict does to the search: a minor verdict narrows a non-moderator to the safe
 * levels; moderators keep the refusal, since they search to find what must come down.
 */
export function queryVerdictLevel(
  refusal: QueryRefusal,
  level: number,
  isModerator?: boolean
): number | 'refuse' {
  if (!refusal) return level;
  if ((refusal === 'minor' || refusal === 'minor-safe') && !isModerator)
    return Flags.intersection(level, sfwBrowsingLevelsFlag) || publicBrowsingLevelsFlag;
  return 'refuse';
}

export type DryRunOutcome = { verdict: QueryRefusal; result: 'allow' | 'narrow' | 'refuse' };

/**
 * What the query audit would do to `query` for a non-moderator and for a moderator, at every
 * browsing level. The verdict only: never which list or term matched.
 */
export async function dryRunSemanticQuery(query: string) {
  const outcome = async (isModerator: boolean): Promise<DryRunOutcome> => {
    const verdict = await semanticQueryRefusal(query, {
      browsingLevel: allBrowsingLevelsFlag,
      disablePoi: false,
      isModerator,
    });
    const level = queryVerdictLevel(verdict, allBrowsingLevelsFlag, isModerator);
    const result =
      level === 'refuse' ? 'refuse' : level === allBrowsingLevelsFlag ? 'allow' : 'narrow';
    return { verdict, result };
  };
  return { nonModerator: await outcome(false), moderator: await outcome(true) };
}

export type QueryStage = 'query' | 'correction';

export function recordRefusal(
  track: QueryTracker | undefined,
  refusal: QueryRefusal,
  query: string,
  index: string,
  stage: QueryStage = 'query'
) {
  if (!refusal) return;
  countQueryVerdict(index, refusal, stage);
  if (refusal !== 'minor' && refusal !== 'poi-minor') return;
  track?.action({ type: 'CSAM_Help_Triggered', details: { query, index } }).catch(() => undefined);
}

/**
 * One search's query audit: each verdict is counted, tracked and given to `audit`. `context` is read
 * on every call, so a correction is audited at the level the search has narrowed to by then.
 */
export function makeRefusalOf({
  index,
  track,
  context,
  audit,
}: {
  index: string;
  track?: QueryTracker;
  context: () => Parameters<typeof semanticQueryRefusal>[1];
  audit?: { verdict: (refusal: QueryRefusal) => void };
}) {
  return async (text: string, stage: QueryStage) => {
    const refusal = await semanticQueryRefusal(text, context());
    recordRefusal(track, refusal, text, index, stage);
    audit?.verdict(refusal);
    return refusal;
  };
}

/**
 * What a semantic search settles before it searches: the viewer's level (clamped, then capped by
 * the site), their hidden users, and the query audit. Null when the query is refused. The returned
 * `browsingLevel` is the level the feed filters on, and `refusalOf` audits at it, so a correction is
 * judged at the level the query was narrowed to.
 */
export async function semanticSearchPrelude({
  index,
  query,
  requestedLevel,
  user,
  isGreen,
  browsingLevelCap,
  track,
}: {
  index: string;
  query: string;
  requestedLevel: number | undefined;
  user: SessionUser | undefined;
  isGreen: boolean;
  /** The site's cap (requestDomainBrowsingLevelCap); undefined on an uncapped site. */
  browsingLevelCap: number | undefined;
  track?: QueryTracker;
}) {
  let browsingLevel = resolveSemanticBrowsingLevel(
    requestedLevel,
    user,
    await isNonModClampOn(user)
  );
  if (browsingLevelCap !== undefined)
    browsingLevel = Flags.intersection(browsingLevel, browsingLevelCap) || browsingLevelCap;
  const [hidden, addonData] = await Promise.all([
    getAllHiddenForUser({ userId: user?.id }),
    getBrowsingSettingAddons(),
  ]);
  const { disablePoi } = resolveBrowsingSettingsAddons(addonData, browsingLevel, {
    isModerator: user?.isModerator,
  });
  const refusalOf = makeRefusalOf({
    index,
    track,
    context: () => ({ browsingLevel, disablePoi, isModerator: user?.isModerator }),
  });
  const verdictLevel = queryVerdictLevel(
    await refusalOf(query, 'query'),
    browsingLevel,
    user?.isModerator
  );
  if (verdictLevel === 'refuse') return null;
  browsingLevel = getEffectiveBrowsingLevel({
    isGreen,
    isLoggedIn: !!user,
    requested: verdictLevel,
  });
  return { browsingLevel, hidden, refusalOf };
}

/** The candidates a refused text search would have served, for its audit row only. */
export function refusedTextCandidates(
  source: CandidateSource,
  { text, filter, viewer }: { text: string; filter: CandidateFilter; viewer: SearchViewer }
): () => Promise<RefusedCandidates> {
  return () => source({ query: { text }, filter, offset: 0, limit: AUDIT_RESULT_IDS, viewer });
}

/**
 * What one semantic search learns along the way, recorded as one row when its first page is
 * returned. Services report verdicts and candidate results to it as they happen.
 */
export function beginSemanticAudit({
  index,
  viewer,
  query,
  firstPage,
}: {
  index: SearchCollection;
  viewer: SemanticAuditEntry['viewer'];
  query: string | undefined;
  firstPage: boolean;
}) {
  let wordVerdict: QueryRefusal = false;
  let withholdIds = false;
  let withholdComputedIds = false;
  let candidates: { guard?: GuardRead; cacheHit?: boolean } | undefined;
  const entry = (
    browsingLevel: number,
    resultIds: number[],
    searchPath: SemanticSearchPath
  ): SemanticAuditEntry => ({
    index,
    viewer,
    query: query ?? '',
    browsingLevel,
    wordVerdict,
    withholdIds,
    withholdComputedIds,
    resultsServed: true,
    searchPath,
    // Called but sent no guard: a cached block stored without one.
    guard: candidates ? candidates.guard ?? { ...GUARD_NONE, outcome: 'unknown' } : GUARD_NONE,
    cacheHit: candidates?.cacheHit ?? false,
    resultIds,
  });
  return {
    verdict(refusal: QueryRefusal) {
      if (!refusal) return;
      wordVerdict ||= refusal;
      if (!verdictKeepsServedIds(refusal)) withholdIds = true;
      if (!verdictComputesRefusedIds(refusal)) withholdComputedIds = true;
    },
    candidates(result: { guard?: GuardRead; cacheHit?: boolean } | undefined) {
      candidates ??= result;
    },
    done<R extends { items: { id: number }[] }>(
      result: R,
      browsingLevel: number,
      searchPath?: SemanticSearchPath
    ): R {
      if (firstPage)
        recordSemanticAudit(
          entry(
            browsingLevel,
            result.items.map((x) => x.id),
            searchPath ?? (wordVerdict ? 'narrowed' : 'served')
          )
        );
      return result;
    },
    /**
     * A refused search: serves `result` (nothing) at once. The audit may then run `compute` for
     * the candidates the search would have served, never shown to anyone.
     */
    refused<R extends { items: { id: number }[] }>(
      searchPath: RefusedSearchPath,
      result: R,
      browsingLevel: number,
      compute: () => Promise<RefusedCandidates>
    ): R {
      if (firstPage) recordRefusedSemanticAudit(entry(browsingLevel, [], searchPath), compute);
      return result;
    },
  };
}
