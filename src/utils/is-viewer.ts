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
