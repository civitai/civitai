/** The longest clip the video search index holds: the embed worker skips longer ones. */
export const MAX_INDEXED_VIDEO_SECONDS = 60;

export const videoLengthPresets = ['under5', '5to15', '15to30', '30to60'] as const;
export type VideoLengthPreset = (typeof videoLengthPresets)[number];

/** Seconds: `gte` and `lte` inclusive, `lt` exclusive. */
export const VIDEO_LENGTH_BOUNDS: Record<
  VideoLengthPreset,
  { gte: number; lt?: number; lte?: number }
> = {
  under5: { gte: 0, lt: 5 },
  '5to15': { gte: 5, lt: 15 },
  '15to30': { gte: 15, lt: 30 },
  '30to60': { gte: 30, lte: MAX_INDEXED_VIDEO_SECONDS },
};
