import { BlocklistType } from '~/server/common/enums';
import type { Tracker } from '~/server/clickhouse/tracker';
import { stripBenignPhrases } from '~/server/services/blocklist.service';
import {
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
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';
import { includesInappropriate, includesMinor, includesPoi } from '~/utils/metadata/audit';

export type QueryTracker = Pick<Tracker, 'action'>;
export type QueryRefusal = 'minor' | 'poi' | 'poi-minor' | 'error' | false;

/** The viewer's own level; with `clamp` (the containment switch), non-moderators get the safe levels. */
export function resolveSemanticBrowsingLevel(
  requested: number | undefined,
  user: SessionUser | undefined,
  clamp: boolean
) {
  const level = requested || publicBrowsingLevelsFlag;
  if (user?.isModerator || !clamp) return level;
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
  } catch {
    return true;
  }
}

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
  if (refusal === 'minor' && !isModerator)
    return Flags.intersection(level, sfwBrowsingLevelsFlag) || publicBrowsingLevelsFlag;
  return 'refuse';
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
