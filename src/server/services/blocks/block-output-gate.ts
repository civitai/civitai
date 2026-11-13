import { NsfwLevel } from '~/server/common/enums';
import type { BlockMediaType } from '~/server/services/blocks/block-media-token';
import { isGlbFormat } from '~/shared/orchestrator/model3d-output';
import type { NormalizedWorkflowStepOutput } from '~/server/services/orchestrator/orchestration-new.service';
import { isUnratedOutput } from '~/shared/orchestrator/workflow-data';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

export type BlockOutputHiddenReason =
  | 'blocked'
  | 'above_level'
  | 'unknown_rating'
  | 'unrated'
  | 'owner_only'
  | 'private'
  | 'paused'
  | 'unrecognised_url';

export type BlockOutputGate =
  | { state: 'visible'; nsfwLevel: NsfwLevel | null }
  | { state: 'pending' }
  | { state: 'hidden'; reason: BlockOutputHiddenReason };

export type BlockOutputGateItem = {
  mediaType: BlockMediaType;
  /** The raw orchestrator rating string; null until the scan has a verdict. */
  nsfwLevel: string | null;
  blockedReason?: string | null;
  format?: string | null;
  /** A GLB mesh's rated preview render, when its step output carries one. */
  previewNsfwLevel?: string | null;
  /** `isNeverRatedVideoStep` for the step that produced the item. */
  neverRatedVideoStep: boolean;
  privateGen: boolean;
  ownerId: number;
};

export type BlockOutputViewer = { userId: number | null; browsingLevel: number };

/**
 * Orchestrator ratings this gate understands. Step-output `na` is a verdict with
 * no level, and reads as PG. Anything else is refused rather than mapped, so a
 * rating added upstream can only hide.
 */
const KNOWN_RATINGS: Record<string, NsfwLevel> = {
  na: NsfwLevel.PG,
  pg: NsfwLevel.PG,
  pg13: NsfwLevel.PG13,
  r: NsfwLevel.R,
  x: NsfwLevel.X,
  xxx: NsfwLevel.XXX,
};

const hidden = (reason: BlockOutputHiddenReason): BlockOutputGate => ({ state: 'hidden', reason });

/**
 * Whether one App Block workflow output may be served to this viewer.
 *
 * 🔴 Never reads `available`: videoGen reports `available: true` for blocked
 * output, so the block verdict comes from `blockedReason` alone.
 */
export function deriveOutputGate(
  item: BlockOutputGateItem,
  viewer: BlockOutputViewer
): BlockOutputGate {
  if (item.blockedReason && item.blockedReason !== 'none') return hidden('blocked');

  const isOwner = viewer.userId !== null && viewer.userId === item.ownerId;
  let rating = item.nsfwLevel;

  if (item.mediaType === 'model3d' && isGlbFormat(item.format) && item.previewNsfwLevel != null) {
    rating = item.previewNsfwLevel;
  } else if (
    item.mediaType === 'model3d' ||
    item.mediaType === 'audio' ||
    item.mediaType === 'archive'
  ) {
    return isOwner ? { state: 'visible', nsfwLevel: null } : hidden('owner_only');
  }

  if (item.mediaType === 'video' && item.neverRatedVideoStep) return hidden('unrated');

  if (
    (item.mediaType === 'image' || item.mediaType === 'video') &&
    isUnratedOutput(
      {
        type: item.mediaType,
        available: true,
        nsfwLevel: rating as NormalizedWorkflowStepOutput['nsfwLevel'],
        blockedReason: item.blockedReason ?? undefined,
      },
      item.neverRatedVideoStep
    )
  )
    return { state: 'pending' };

  const level = KNOWN_RATINGS[(rating ?? '').toLowerCase()];
  if (level === undefined) return hidden('unknown_rating');

  if ((level & viewer.browsingLevel) === 0) return hidden('above_level');

  if (item.privateGen && (level & sfwBrowsingLevelsFlag) === 0 && !isOwner)
    return hidden('private');

  return { state: 'visible', nsfwLevel: level };
}
