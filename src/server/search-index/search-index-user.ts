/**
 * A user object for a search index document, without `image`: that legacy avatar URL carries no
 * rating, so a capped viewer could be served it. `profilePicture` (rated and capped at read) is
 * what search hits show.
 */
export function withoutUserImage<T extends { image?: unknown }>(user: T): Omit<T, 'image'> {
  const { image: _image, ...rest } = user;
  return rest;
}
