/**
 * Locks come from the stored row, never the payload: enforcing against a client-supplied
 * `lockedProperties` lets a creator unlock their own entity, and letting that array reach
 * the write erases the stored locks outright.
 *
 * Shared by the model, article and bounty upserts — a per-service copy drifted before.
 */
export function enforceLockedProperties<T extends { lockedProperties?: string[] }>({
  data,
  storedLockedProperties,
  isModerator,
}: {
  data: T;
  storedLockedProperties?: string[] | null;
  isModerator?: boolean;
}) {
  if (isModerator) return;

  for (const prop of storedLockedProperties ?? []) delete (data as Record<string, unknown>)[prop];
  delete (data as Record<string, unknown>).lockedProperties;
}
