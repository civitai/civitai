import type { Prisma } from '@prisma/client';

/**
 * Everything that describes a mute, cleared as one unit when it is lifted.
 *
 * Four things say why an account is muted, and they have to die together. `mutedAt` says a moderator
 * stands behind it — `confirm-mutes`, `entity-moderation`, `prepare-leaderboard` and
 * `evaluateStrikeEscalation` all read it that way. `meta.muteReason`/`mutedBy` say why and who.
 *
 * Left behind on a lift they describe a mute that is over: the account stays off every leaderboard
 * (`mutedAt IS NULL` is part of eligibility), and the next AUTOMATIC mute on that account inherits a
 * stranger's reason and moderator on the screen a ban is decided on.
 *
 * Its own module, and free of DB/env imports, so `strike.service` and the restriction resolver can use
 * the real function under test rather than a hand-written mock of it — the assertion that the keys are
 * gone is worth nothing against a reimplementation.
 */
export function clearedMuteFields(meta: unknown) {
  const next = { ...((meta ?? {}) as Record<string, unknown>) };
  // Only the mute's own keys. Everything else on `meta` belongs to other subsystems and survives.
  delete next.muteReason;
  delete next.mutedBy;
  return {
    muted: false,
    mutedAt: null,
    muteExpiresAt: null,
    meta: next as Prisma.InputJsonValue,
  };
}
