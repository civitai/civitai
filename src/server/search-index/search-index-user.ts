/**
 * A user object for a search index document with `image` set to null: that legacy avatar URL carries
 * no rating, so a capped viewer could be served it. `profilePicture` (rated and capped at read) is what
 * search hits show. Null rather than absent keeps the field the hit types expect, and an update that
 * merges into a stored document clears an old value.
 */
export function withoutUserImage<T extends { image?: unknown }>(
  user: T
): Omit<T, 'image'> & { image: null } {
  const { image: _image, ...rest } = user;
  return { ...rest, image: null };
}

/** Documents for a refresh of only the `user` of each document (the moderator search tools). */
export const userRefreshDocuments = <T extends { image?: unknown }>(
  records: { id: number; user: T }[]
) => records.map(({ id, user }) => ({ id, user: withoutUserImage(user) }));
