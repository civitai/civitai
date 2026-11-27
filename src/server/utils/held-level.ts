import { Flags } from '~/shared/utils/flags';

/**
 * Whether a model's hold on a post (`getHeldLevelsByPost`) leaves one of its images at `nsfwLevel`
 * to `viewerId`: there is no hold, the viewer owns the holding model, or the level is within the
 * hold. Pass `viewerId` only for a sign-in that may act as that owner.
 */
export const holdLeavesImage = (
  hold: { level: number; ownerId?: number } | undefined,
  viewerId: number | undefined,
  nsfwLevel: number
) =>
  !hold ||
  (viewerId != null && hold.ownerId === viewerId) ||
  Flags.intersects(hold.level, nsfwLevel);
