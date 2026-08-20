import { validNsfwLevels, NsfwLevel } from '@civitai/shared';

/** A level a moderator may set. `Blocked` is included: it is how a rating queue removes an image.
 *  Front Page Audit deliberately excludes it and keeps its own narrower check. */
export const isRatingLevel = (n: number) => validNsfwLevels.has(n) || n === NsfwLevel.Blocked;
