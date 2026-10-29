import { MODEL_FLAGS_APPEALS_PATH } from '$lib/minor-flags/paths';
import { SITE_APPEAL_QUEUES, siteAppealQueuePath } from '$lib/site-appeals';

/** The queue an appeal is decided in: each is its own page, so each is read under its own grant. */
export type AppealKind = 'removed' | 'site' | 'modelFlag' | 'image';

export const APPEAL_KIND_LABEL: Record<AppealKind, string> = {
  removed: 'Content removed',
  site: 'Site form',
  modelFlag: 'Model flag',
  image: 'Image',
};

/** Decided appeals this old no longer count as recent; pending ones always show. */
export const APPEAL_WINDOW_DAYS = 30;
/** Rows shown. */
export const APPEAL_ROWS = 25;

const IMAGE_APPEALS_PATH = '/images/appeals';
const REMOVED_APPEALS_PATH = '/images/removed-appeals';

/**
 * Each row in exactly one kind, first match wins: a removed-content appeal can also carry a form
 * category, and a form appeal about a model is not a model flag. `null` for a row no queue shows.
 */
export function classifyAppeal(row: {
  entityType: string;
  entityRemovedAt: Date | string | null;
  category: string | null;
}): AppealKind | null {
  if (row.entityRemovedAt !== null) return 'removed';
  if (row.category !== null) return 'site';
  if (row.entityType === 'Model') return 'modelFlag';
  if (row.entityType === 'Image') return 'image';
  return null;
}

export function appealQueuePath(kind: AppealKind, category: string | null): string | null {
  if (kind === 'image') return IMAGE_APPEALS_PATH;
  if (kind === 'removed') return REMOVED_APPEALS_PATH;
  if (kind === 'modelFlag') return MODEL_FLAGS_APPEALS_PATH;
  const queue = SITE_APPEAL_QUEUES.find((q) => q.category === category);
  return queue ? siteAppealQueuePath(queue.slug) : null;
}

export const APPEAL_QUEUE_PATHS: readonly string[] = [
  IMAGE_APPEALS_PATH,
  REMOVED_APPEALS_PATH,
  MODEL_FLAGS_APPEALS_PATH,
  ...SITE_APPEAL_QUEUES.map((q) => siteAppealQueuePath(q.slug)),
];
