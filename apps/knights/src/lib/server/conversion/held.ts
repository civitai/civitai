import { sql, type SqlBool } from 'kysely';

/** A player is held while a payout block is set or the account is banned. */
export const heldSql = (playerColumn: string) =>
  sql<SqlBool>`(EXISTS (SELECT 1 FROM "NewOrderPlayer" hp WHERE hp."userId" = ${sql.ref(
    playerColumn
  )} AND hp."payoutBlockedAt" IS NOT NULL) OR EXISTS (SELECT 1 FROM "User" hu WHERE hu."id" = ${sql.ref(
    playerColumn
  )} AND hu."bannedAt" IS NOT NULL))`;
