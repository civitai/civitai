import { useMemo } from 'react';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { trpc } from '~/utils/trpc';

type WithDetails = { details?: Record<string, unknown> | null };

export type NotificationThumbnailImage = NonNullable<
  ReturnType<typeof useNotificationThumbnails> extends Map<number, infer T> ? T : never
>;

/**
 * Notifications that name an image, deduped, in the order they appear.
 *
 * `imageId` is the key every processor that points at an image already writes,
 * so a notification type added later is covered without being listed here.
 */
export function notificationImageId(details: WithDetails['details']) {
  const id = Number(details?.imageId);

  return Number.isInteger(id) && id > 0 ? id : null;
}

export function notificationImageIds(items: WithDetails[]) {
  const ids = new Set<number>();
  for (const { details } of items) {
    const id = notificationImageId(details);
    if (id) ids.add(id);
  }

  return [...ids];
}

/**
 * Resolved when the panel opens, never stored on the notification.
 *
 * `details` is frozen at write time: a url and level stamped into it keep
 * rendering an image that has since been deleted, moderated or re-levelled, at
 * the level it had the day the row was written. That is a browsing-level gate
 * that silently stops being correct, where reading now is current by
 * construction and costs one batched query for the whole panel.
 *
 * An image the viewer may not see is dropped by `useApplyHiddenPreferences`
 * rather than blurred, so the row falls back to its icon and nothing about the
 * image is disclosed by the shape of the fallback. Whether a visible image is
 * shown uncovered is a separate question, answered by `ImageGuard2` at the
 * render site.
 *
 * ⚠️ The ids are trusted because every processor writing `details.imageId`
 * addresses the image's owner or a participant on a published image. A
 * processor that names an image its recipient is not otherwise entitled to see
 * — something in a draft post, a moderation queue, anything private — would be
 * rendering it here with no gate beyond the viewer's own preferences, and
 * nothing in this file would need to change for that to happen.
 */
export function useNotificationThumbnails(items: WithDetails[]) {
  const imageIds = useMemo(() => notificationImageIds(items), [items]);

  const { data } = trpc.image.getEntitiesCoverImage.useQuery(
    { entities: imageIds.map((entityId) => ({ entityType: 'Image' as const, entityId })) },
    { enabled: imageIds.length > 0, trpc: { context: { skipBatch: true } } }
  );

  const withTagIds = useMemo(
    () => data?.map((image) => ({ ...image, tagIds: image.tags?.map((tag) => tag.id) })) ?? [],
    [data]
  );
  const { items: visible } = useApplyHiddenPreferences({ type: 'images', data: withTagIds });

  return useMemo(() => new Map(visible.map((image) => [image.id, image])), [visible]);
}
