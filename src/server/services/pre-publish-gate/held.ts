import { Prisma } from '@prisma/client';

// A version the gate held, or one a moderator declined since: only a moderator publishes it. One
// definition, read both from a version's meta and in the database. A decline is known by its
// timestamp, which every decline writes (its reason is optional).
// "decliendAt" (sic) is the key the version decline writes in model-version.controller.ts; do not correct the spelling.
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
