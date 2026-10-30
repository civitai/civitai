/**
 * A block already hides the target and outranks a hide, so the server refuses a
 * hide over one. Offering a blocked user as hideable produces no badge and no
 * toast, so they are dropped from the search results entirely.
 */
export function toHideableOptions(
  data: Array<{ id: number; username: string | null }> | undefined,
  blockedUsers: Array<{ id: number }>
) {
  return (
    data
      ?.filter((x) => x.username && !blockedUsers.some((b) => b.id === x.id))
      .map(({ id, username }) => ({ id, value: username ?? '' })) ?? []
  );
}
