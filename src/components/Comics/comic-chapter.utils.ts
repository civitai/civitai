import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { EntityAccessPermission } from '~/server/common/enums';

/**
 * Checks the current user's access permissions for a comic chapter.
 * Mirrors the useModelVersionPermission pattern.
 *
 * Returns:
 *  - canRead: whether the user can view chapter panels
 *  - canDownload: whether the user can download the chapter
 *  - isEarlyAccess: whether the chapter is currently in early access
 *  - isLoadingAccess: whether the access check is still loading
 *
 * Access is granted when:
 *  - The chapter is NOT in early access (EA expired or never set), OR
 *  - The user is the project owner / a moderator, OR
 *  - The user has purchased EA access (EntityAccess with the relevant permission bit)
 */
export function useChapterPermission({
  chapterId,
  projectUserId,
  earlyAccessEndsAt,
}: {
  chapterId?: number;
  projectUserId?: number;
  earlyAccessEndsAt?: Date | string | null;
}) {
  const currentUser = useCurrentUser();

  const isOwnerOrMod =
    currentUser != null &&
    (currentUser.id === projectUserId || currentUser.isModerator === true);

  const isEarlyAccess =
    !!earlyAccessEndsAt && new Date(earlyAccessEndsAt) > new Date();

  // Only query EntityAccess if the chapter is actually EA-locked and user isn't owner/mod
  const needsAccessCheck = isEarlyAccess && !isOwnerOrMod && !!chapterId;
  const { data: entities, isLoading: isLoadingAccess } = trpc.common.getEntityAccess.useQuery(
    { entityType: 'ComicChapter', entityId: [chapterId!] },
    { enabled: needsAccessCheck }
  );

  if (isOwnerOrMod) {
    return { canRead: true, canDownload: true, isEarlyAccess, isLoadingAccess: false };
  }

  if (!isEarlyAccess) {
    return { canRead: true, canDownload: true, isEarlyAccess: false, isLoadingAccess: false };
  }

  // Chapter is in EA — check purchased permissions
  const [access] = entities ?? [];
  const hasAccess = !!access?.hasAccess;
  const canRead =
    hasAccess &&
    ((access.permissions & EntityAccessPermission.EarlyAccessGeneration) !== 0 ||
      (access.permissions & EntityAccessPermission.EarlyAccessDownload) !== 0);
  const canDownload =
    hasAccess &&
    (access.permissions & EntityAccessPermission.EarlyAccessDownload) !== 0;

  return {
    canRead: !!canRead,
    canDownload: !!canDownload,
    isEarlyAccess,
    isLoadingAccess: needsAccessCheck && isLoadingAccess,
  };
}
