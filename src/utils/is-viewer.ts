/**
 * Whether `userId` is the signed-in viewer. Use this rather than `userId === currentUser?.id`:
 * that is `undefined === undefined` for a signed-out viewer and a missing owner id.
 */
export function isViewer(
  currentUser: { id: number } | null | undefined,
  userId: number | null | undefined
): boolean {
  return !!currentUser && userId != null && userId === currentUser.id;
}

/** Whether `username` names the signed-in viewer, case-insensitively. */
export function isViewerUsername(
  currentUser: { username?: string | null } | null | undefined,
  username: string | null | undefined
): boolean {
  return (
    !!currentUser && !!username && username.toLowerCase() === currentUser.username?.toLowerCase()
  );
}

/** Whether the viewer owns `ownerId`, or is a moderator. */
export function isViewerOrModerator(
  viewer: { id?: number | null; isModerator?: boolean | null },
  ownerId: number
): boolean {
  return (!!viewer.id && viewer.id === ownerId) || !!viewer.isModerator;
}
