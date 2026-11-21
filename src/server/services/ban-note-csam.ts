import { Prisma } from '@prisma/client';

/** SQL: true when a User `meta` column holds ban notes, internal or external, naming CSAM or NCMEC. */
export const banNoteNamesCsamSql = (meta: Prisma.Sql) => Prisma.sql`concat_ws(' ',
  ${meta} -> 'banDetails' ->> 'detailsInternal',
  ${meta} -> 'banDetails' ->> 'detailsExternal') ~* '(csam|ncmec)'`;

/** The ModActivity activity a moderator's release of a ban-note hold records. */
export const BAN_NOTE_HOLD_RELEASE_ACTIVITY = 'releaseBanNoteHold';

/**
 * SQL: true when the User row aliased `u` is banned with a note naming CSAM or NCMEC and no moderator
 * has released that hold during the current ban. A release counts only when recorded at or after
 * `bannedAt`, so a re-ban needs a new one; a NULL `bannedAt` counts as unreleased.
 */
export const banNoteHeldUserSql = (u: string) => {
  const row = Prisma.raw(u);
  return Prisma.sql`(${banNoteNamesCsamSql(Prisma.sql`${row}.meta`)}
    AND NOT EXISTS (
      SELECT 1 FROM "ModActivity" bnr
      WHERE bnr.activity = ${BAN_NOTE_HOLD_RELEASE_ACTIVITY}
        AND bnr."entityType" = 'user'
        AND bnr."entityId" = ${row}.id
        AND bnr."createdAt" >= ${row}."bannedAt"
    ))`;
};

/** SQL: `banNoteHeldUserSql` for the user `id`, an int SQL expression. */
export const banNoteHoldSql = (id: Prisma.Sql) =>
  Prisma.sql`EXISTS (SELECT 1 FROM "User" bnu WHERE bnu.id = ${id} AND ${banNoteHeldUserSql(
    'bnu'
  )})`;

/**
 * The ids of banned users `banNoteHeldUserSql` holds, as one text column `userId`. Only rows with a
 * `bannedAt`, to stay on its partial index: a ban note on a user with none is not read here.
 */
export const banNoteHeldUserIdsSql = Prisma.sql`
  SELECT bnu.id::text AS "userId" FROM "User" bnu
  WHERE bnu."bannedAt" IS NOT NULL AND ${banNoteHeldUserSql('bnu')}`;
