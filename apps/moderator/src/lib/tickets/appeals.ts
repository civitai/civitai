import { MODEL_FLAGS_APPEALS_PATH } from '$lib/minor-flags/paths';
import { SITE_APPEAL_QUEUES, siteAppealQueuePath } from '$lib/site-appeals';

/** The queue an appeal is decided in: each is its own page, so each is read under its own grant. */
export type AppealKind = 'removed' | 'site' | 'modelFlag' | 'song' | 'image';

export const APPEAL_KIND_LABEL: Record<AppealKind, string> = {
  removed: 'Content removed',
  site: 'Site form',
  modelFlag: 'Model flag',
  song: 'Song or cover',
  image: 'Image',
};

/** Decided appeals this old no longer count as recent; pending ones always show. */
export const APPEAL_WINDOW_DAYS = 30;
/** Rows shown. */
export const APPEAL_ROWS = 25;

export const IMAGE_APPEALS_PATH = '/images/appeals';
export const REMOVED_APPEALS_PATH = '/images/removed-appeals';
/** Appeals of a song or a song's own cover are decided on Audio review's Appeals tab. */
export const AUDIO_REVIEW_PATH = '/audio-review';
export const songAppealsHref = (imageId: number) => `${AUDIO_REVIEW_PATH}?tab=appeals&q=${imageId}`;
/** Account appeals are decided in the ticket's Account card, which lifts the ban or mute with the ruling. */
export const ACCOUNT_APPEALS_PATH = siteAppealQueuePath('account');

/**
 * Each row in exactly one kind, first match wins: a removed-content appeal can also carry a form
 * category, and a form appeal about a model is not a model flag. `null` for a row no queue shows.
 * `songImage`: the appealed image is a song or a song's own cover (`songOrOwnCoverText`).
 */
export function classifyAppeal(
  row: {
    entityType: string;
    entityRemovedAt: Date | string | null;
    category: string | null;
  },
  songImage = false
): AppealKind | null {
  if (row.entityRemovedAt !== null) return 'removed';
  if (row.category !== null) return 'site';
  if (row.entityType === 'Model') return 'modelFlag';
  if (row.entityType === 'Image') return songImage ? 'song' : 'image';
  return null;
}

export function appealQueuePath(kind: AppealKind, category: string | null): string | null {
  if (kind === 'image') return IMAGE_APPEALS_PATH;
  if (kind === 'song') return AUDIO_REVIEW_PATH;
  if (kind === 'removed') return REMOVED_APPEALS_PATH;
  if (kind === 'modelFlag') return MODEL_FLAGS_APPEALS_PATH;
  const queue = SITE_APPEAL_QUEUES.find((q) => q.category === category);
  return queue ? siteAppealQueuePath(queue.slug) : null;
}

export const APPEAL_QUEUE_PATHS: readonly string[] = [
  IMAGE_APPEALS_PATH,
  AUDIO_REVIEW_PATH,
  REMOVED_APPEALS_PATH,
  MODEL_FLAGS_APPEALS_PATH,
  ...SITE_APPEAL_QUEUES.map((q) => siteAppealQueuePath(q.slug)),
];
