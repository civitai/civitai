/**
 * Whether `user` may generate with a model version on access grounds alone: a Private version, or
 * one still in Draft or Training, is usable only by its owner or a moderator. Coverage, status and
 * base-model rules are separate (see `getResourceCanGenerate`).
 */
export function canAccessGenerationResource(
  resource: { availability: string; status: string; modelUserId: number },
  user: { id?: number; isModerator?: boolean }
): boolean {
  const restricted =
    resource.availability === 'Private' || ['Draft', 'Training'].includes(resource.status);
  return !restricted || (!!user.id && user.id === resource.modelUserId) || !!user.isModerator;
}
