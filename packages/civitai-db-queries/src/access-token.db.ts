import { createHash, randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// The one copy of the access-token rules. The main app's Prisma service and the moderator app's case
// links both read these, so a link token is hashed, checked and expired the same way everywhere.

/** What an access token can open. `CaseParty` is a takedown case party (moderator DB case_party.id). */
export type AccessTokenResourceType = 'Article' | 'CaseParty';

export const hashAccessToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** A fresh raw token: 32 random bytes, URL-safe. Only its hash is stored. */
export const newAccessToken = () => randomBytes(32).toString('base64url');

/** Revoked, expired or for another kind of resource: the row grants nothing. */
export function isUsableAccessToken(
  row: { resourceType: string; expiresAt: Date; revokedAt: Date | null } | null | undefined,
  resourceType: AccessTokenResourceType,
  now = new Date()
): boolean {
  return (
    !!row &&
    row.resourceType === resourceType &&
    row.revokedAt === null &&
    row.expiresAt.getTime() > now.getTime()
  );
}

// The columns are zoneless timestamps holding UTC; read as-is, node-postgres would take them as
// server-local time.
const utc = (column: string) => sql<Date | null>`${sql.ref(column)} AT TIME ZONE 'UTC'`;

/** Mints one token and returns the raw value, which is never stored. */
export async function mintAccessToken(
  db: Kysely<DB>,
  input: {
    resourceType: AccessTokenResourceType;
    resourceId: number;
    createdById: number;
    expiresAt: Date;
  }
) {
  const token = newAccessToken();
  await db
    .insertInto('AccessToken')
    .values({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      createdById: input.createdById,
      // Written as UTC wall time into the zoneless column.
      expiresAt: sql`(${input.expiresAt.toISOString()}::timestamptz AT TIME ZONE 'UTC')`,
      tokenHash: hashAccessToken(token),
    })
    .execute();
  return token;
}

/**
 * The row behind a raw token, only while it still grants access to that kind of resource. Pass the
 * primary, so a revoke takes effect on the very next request.
 */
export async function resolveAccessToken(
  db: Kysely<DB>,
  token: string,
  resourceType: AccessTokenResourceType,
  now = new Date()
) {
  const row = await db
    .selectFrom('AccessToken')
    .select([
      'id',
      'resourceType',
      'resourceId',
      utc('expiresAt').as('expiresAt'),
      utc('revokedAt').as('revokedAt'),
    ])
    .where('tokenHash', '=', hashAccessToken(token))
    .executeTakeFirst();
  if (!row || !row.expiresAt) return null;
  const usable = { ...row, expiresAt: row.expiresAt, revokedAt: row.revokedAt };
  return isUsableAccessToken(usable, resourceType, now) ? usable : null;
}
