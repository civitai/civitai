import { BlocklistType } from '~/server/common/enums';
import type { Tracker } from '~/server/clickhouse/tracker';
import { stripBenignPhrases } from '~/server/services/blocklist.service';
import {
  nsfwBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { countQueryVerdict } from '~/server/metrics/semantic-search.metrics';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';
import { includesInappropriate, includesMinor, includesPoi } from '~/utils/metadata/audit';

export type QueryTracker = Pick<Tracker, 'action'>;
export type QueryRefusal = 'minor' | 'poi' | 'poi-minor' | 'error' | false;

/** Only moderators search above the safe levels. */
export function resolveSemanticBrowsingLevel(requested: number | undefined, user?: SessionUser) {
  const level = requested || publicBrowsingLevelsFlag;
  if (user?.isModerator) return level;
  return Flags.intersection(level, sfwBrowsingLevelsFlag) || publicBrowsingLevelsFlag;
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
    // Only moderators may look real people up, and then only without the POI add-on.
    if ((disablePoi || !isModerator) && includesPoi(audited)) return 'poi';
    return false;
  } catch {
    return 'error';
  }
}

/** A minor verdict narrows the search to the safe levels instead of refusing it. */
export function minorSafeBrowsingLevel(level: number) {
  return Flags.intersection(level, sfwBrowsingLevelsFlag) || publicBrowsingLevelsFlag;
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
