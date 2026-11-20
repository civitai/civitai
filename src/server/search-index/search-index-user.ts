/**
 * A user object for a search index document, without `image`: that legacy avatar URL carries no
 * rating, so a capped viewer could be served it. `profilePicture` (rated and capped at read) is
 * what search hits show.
 */
export function withoutUserImage<T extends { image?: unknown }>(user: T): Omit<T, 'image'> {
  const { image: _image, ...rest } = user;
  return rest;
}

/** Documents for a refresh of only the `user` of each document (the moderator search tools). */
export const userRefreshDocuments = <T extends { image?: unknown }>(
  records: { id: number; user: T }[]
) => records.map(({ id, user }) => ({ id, user: withoutUserImage(user) }));
