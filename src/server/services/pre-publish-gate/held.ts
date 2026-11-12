import { Prisma } from '@prisma/client';

// A version the gate held, or one a moderator declined since: only a moderator publishes it. One
// definition, read both from a version's meta and in the database. Any decline key marks a decline.
// Both spellings must stay: the version decline writes "decliendAt".
const DECLINE_KEYS = ['declinedReason', 'declinedAt', 'decliendAt'] as const;

export function isVersionMetaHeld(meta: unknown) {
  const m = (meta ?? {}) as Record<string, unknown>;
  return m.needsReview === true || DECLINE_KEYS.some((key) => key in m);
}

/** A model a moderator declined; read only while the model carries the gate's hold mark. */
export function isMetaDeclined(meta: unknown) {
  const m = (meta ?? {}) as Record<string, unknown>;
  return DECLINE_KEYS.some((key) => key in m);
}

export const heldVersionWhere: Prisma.ModelVersionWhereInput = {
  OR: [
    { meta: { path: ['needsReview'], equals: true } },
    ...DECLINE_KEYS.map((key) => ({ meta: { path: [key], not: Prisma.AnyNull } })),
  ],
};
