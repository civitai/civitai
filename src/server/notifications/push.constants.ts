import { systemNoticeTypes } from '@civitai/notifications';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

/**
 * Notification types (processors with `defaultPush`) that get a `UserPushSetting` row materialized
 * when a user grants push permission for the first time. Materialized, not implied: absence of a
 * row must always mean "no push", so this list is only ever read at grant time. Adding a type later
 * reaches NEW subscribers only — existing subscribers need a hand-run backfill.
 *
 * Only toggleable types belong here: a non-toggleable type (e.g. the strike family) renders no
 * control, so a default push row for it could never be turned off short of revoking the browser
 * permission entirely.
 */
export const DEFAULT_PUSH_TYPES = Object.entries(notificationProcessors)
  .filter(([, processor]) => processor.defaultPush)
  .map(([type]) => type);

// Only a notice's title is a push title: other types keep the content's own title in details.title,
// often a creator-written string.
export function getPushTitle(type: string, details: Record<string, unknown>) {
  const isNotice = (systemNoticeTypes as readonly string[]).includes(type);
  if (isNotice && typeof details.title === 'string' && details.title) return details.title;
  return notificationProcessors[type]?.displayName ?? 'Civitai';
}
