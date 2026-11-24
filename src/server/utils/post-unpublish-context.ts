import { POST_PENDING_DELETE_REASON } from '@civitai/db-queries/content-deletion';

export type PostUnpublishContext = {
  // True when the post carries a `prevPublishedAt` stash — i.e. it was
  // previously public, then unpublished via the parent model/version flow.
  // Drives the restore-only UI in PostEditSidebar: when set, the post
  // cannot be rescheduled, only republished at its original date.
  wasPublished: boolean;
  /**
   * Unpublished by a delete that is kept for now. Its owner is told only that the post isn't
   * available: never why, since a member is never told a delete was kept.
   */
  unavailable: boolean;
  unpublishedAt: Date | null;
  unpublishedBy: number | null;
  // Surfaced via JOIN so the UI can build a link back to the parent model
  // edit page (where the actual unpublish reason + custom message live).
  // We deliberately don't surface the reason directly on the post —
  // model-level reasons like "insufficient-description" don't always map
  // onto the post itself, so showing them in the post alert is misleading.
  parentModelId: number | null;
};

export const PUBLISHED_POST_CONTEXT: PostUnpublishContext = {
  wasPublished: false,
  unavailable: false,
  unpublishedAt: null,
  unpublishedBy: null,
  parentModelId: null,
};

/** What a post's unpublish stamp (`Post.metadata`) tells its owner. */
export function postUnpublishContextOf(
  metadata: Record<string, unknown>,
  parentModelId: number | null
): PostUnpublishContext {
  if (metadata.unpublishedReason === POST_PENDING_DELETE_REASON)
    return { ...PUBLISHED_POST_CONTEXT, unavailable: true };
  const rawUnpublishedAt = metadata.unpublishedAt;
  const rawUnpublishedBy = metadata.unpublishedBy;
  return {
    wasPublished: !!metadata.prevPublishedAt,
    unavailable: false,
    unpublishedAt: typeof rawUnpublishedAt === 'string' ? new Date(rawUnpublishedAt) : null,
    unpublishedBy: typeof rawUnpublishedBy === 'number' ? rawUnpublishedBy : null,
    parentModelId,
  };
}
