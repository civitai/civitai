import { validNsfwLevels, NsfwLevel } from '@civitai/shared';

/** A level a moderator may set. `Blocked` is included: it is how a rating queue removes an image.
 *  Front Page Audit deliberately excludes it and keeps its own narrower check. */
export const isRatingLevel = (n: number) => validNsfwLevels.has(n) || n === NsfwLevel.Blocked;

const DEPRECATED_NAMES: Record<number, 'None' | 'Soft' | 'Mature' | 'X' | 'Blocked'> = {
  [NsfwLevel.PG]: 'None',
  [NsfwLevel.PG13]: 'Soft',
  [NsfwLevel.R]: 'Mature',
  [NsfwLevel.X]: 'X',
  [NsfwLevel.XXX]: 'X',
  [NsfwLevel.Blocked]: 'Blocked',
};

/** The legacy level name ClickHouse `images.nsfw` stores on DeleteTOS rows. */
export const deprecatedNsfwName = (level: number) => DEPRECATED_NAMES[level] ?? 'None';
