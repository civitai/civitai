import { BlocklistType } from '~/server/common/enums';
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
  IDS_WITHHELD_VERDICTS,
  recordSemanticAudit,
  type SemanticAuditEntry,
} from '~/server/services/semantic-search-audit.service';
import {
  GUARD_NONE,
  type GuardRead,
  type SearchCollection,
} from '~/server/services/semantic-search-client';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';
import { includesInappropriate, includesMinor, includesPoi } from '~/utils/metadata/audit';
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
 * levels. Only an explicit `false` lifts it: pass `await isNonModClampOn()`.
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
 * answer all hold it. Read uncached so a flip takes effect at the next refresh.
 */
export async function isNonModClampOn(): Promise<boolean> {
  const flag = FLIPT_FEATURE_FLAGS.SEMANTIC_SEARCH_NONMOD_CLAMP;
  const override = getFliptLocalOverride(flag);
  if (override !== undefined) return override !== 'off';
  await ensureFliptInitialized();
  const client = getFliptClientSync();
  if (!client) return true;
  try {
    return (
      client.evaluateBoolean({ flagKey: flag, entityId: 'global', context: {} }).enabled !== false
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
    const nsfw = Flags.intersects(browsingLevel, nsfwBrowsingLevelsFlag);
    const verdict = includesInappropriate({ prompt: audited }, nsfw);
    if (verdict === 'minor') return 'minor';
    // A 'poi' verdict is returned before the minor check runs, so it can hide one; still refused.
    if (verdict && includesMinor(audited)) return 'poi-minor';
    if (verdict) return verdict;
    if ((disablePoi || !isModerator) && includesPoi(audited)) return 'poi';
    // Mirrors the search boxes, which a request can skip: raw text, since the benign phrases do not
    // carve out this list, and moderators exempt.
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
  let candidates: { guard?: GuardRead; cacheHit?: boolean } | undefined;
  return {
    verdict(refusal: QueryRefusal) {
      if (!refusal) return;
      wordVerdict ||= refusal;
      if (IDS_WITHHELD_VERDICTS.has(refusal)) withholdIds = true;
    },
    candidates(result: { guard?: GuardRead; cacheHit?: boolean } | undefined) {
      candidates ??= result;
    },
    done<R extends { items: { id: number }[] }>(result: R, browsingLevel: number): R {
      if (firstPage)
        recordSemanticAudit({
          index,
          viewer,
          query: query ?? '',
          browsingLevel,
          wordVerdict,
          withholdIds,
          // Called but sent no guard: a cached block from before the guard result, or an old service.
          guard: candidates
            ? candidates.guard ?? { ...GUARD_NONE, outcome: 'unknown' }
            : GUARD_NONE,
          cacheHit: candidates?.cacheHit ?? false,
          resultIds: result.items.map((x) => x.id),
        });
      return result;
    },
  };
}
