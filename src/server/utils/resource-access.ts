/** A Private version, or one in any status other than Published (Draft, Training, Scheduled, Unpublished…). */
export function isRestrictedGenerationResource(resource: { availability: string; status: string }) {
  return resource.availability === 'Private' || resource.status !== 'Published';
}

/**
 * Whether `user` may generate with a model version on access grounds alone: a restricted version
 * (`isRestrictedGenerationResource`) is usable only by its owner or a moderator, and an
 * InternalGeneration one only by a moderator. Coverage and base-model rules are separate (see
 * `getResourceCanGenerate`, whose status rule is stricter).
 */
export function canAccessGenerationResource(
  resource: { availability: string; status: string; modelUserId: number; usageControl?: string },
  user: { id?: number; isModerator?: boolean }
): boolean {
  if (user.isModerator) return true;
  if (resource.usageControl === 'InternalGeneration') return false;
  return (
    !isRestrictedGenerationResource(resource) || (!!user.id && user.id === resource.modelUserId)
  );
}
