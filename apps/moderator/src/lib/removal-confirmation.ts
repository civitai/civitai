/** Why `userId` may not confirm a held removal, or null if they may: the requester and every moderator
 *  whose removal joined the request had a part in it. The confirm's claim statement repeats this in SQL. */
export function confirmRemovalRefusal(
  row: { requestedById: number | null; joinedByIds: number[] },
  userId: number | undefined
): string | null {
  if (userId == null) return null;
  if (row.requestedById === userId)
    return 'You requested this removal, so another moderator must confirm it.';
  if (row.joinedByIds.includes(userId))
    return 'Your removal joined this request, so another moderator must confirm it.';
  return null;
}
