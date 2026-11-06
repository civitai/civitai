import type { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { dbWrite } from '~/server/db/client';

type Db = Prisma.TransactionClient | typeof dbWrite;

export type AccessTokenResourceType = 'Article';

export type AccessTokenRow = {
  id: number;
  resourceType: string;
  resourceId: number;
  createdById: number;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

const accessTokenSelect = {
  id: true,
  resourceType: true,
  resourceId: true,
  createdById: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
} as const;

export const hashAccessToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Revoked, expired or for another kind of resource: the row grants nothing. */
export function isUsableAccessToken(
  row: Pick<AccessTokenRow, 'resourceType' | 'expiresAt' | 'revokedAt'> | null | undefined,
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

/** The where-clause form of `isUsableAccessToken`: rows that still grant access. */
const activeWhere = (now = new Date()) => ({ revokedAt: null, expiresAt: { gt: now } });

export class AccessTokenLimitError extends Error {}
export class AccessTokenNotAllowedError extends Error {}

// Namespaces the advisory lock so it never collides with a single-key lock on the same id.
const ACCESS_TOKEN_LOCK_CLASS = 0x41544b; // 'ATK'

/**
 * Serialises token creation against a writer that must know whether the resource is shared at
 * the moment it writes: whichever commits first, the other sees its result.
 */
export async function lockAccessTokens(tx: Prisma.TransactionClient, resourceId: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ACCESS_TOKEN_LOCK_CLASS}::int, ${resourceId}::int)`;
}

/**
 * The raw token is returned once and never stored. `maxActive` is enforced under a per-resource
 * lock, so two concurrent creates cannot both take the last slot.
 */
export async function createAccessToken({
  resourceType,
  resourceId,
  createdById,
  expiresAt,
  maxActive,
  allowed,
}: {
  resourceType: AccessTokenResourceType;
  resourceId: number;
  createdById: number;
  expiresAt: Date;
  maxActive: number;
  /** Re-checked under the lock, which the resource's own state changes also take. */
  allowed?: (tx: Prisma.TransactionClient) => Promise<boolean>;
}) {
  const token = randomBytes(32).toString('base64url');
  const row = await dbWrite.$transaction(async (tx) => {
    await lockAccessTokens(tx, resourceId);
    if (allowed && !(await allowed(tx))) throw new AccessTokenNotAllowedError();
    const active = await tx.accessToken.count({
      where: { resourceType, resourceId, ...activeWhere() },
    });
    if (active >= maxActive) throw new AccessTokenLimitError();
    return tx.accessToken.create({
      data: { resourceType, resourceId, createdById, expiresAt, tokenHash: hashAccessToken(token) },
      select: accessTokenSelect,
    });
  });
  return { token, row };
}

/**
 * Looks a raw token up by its hash and returns the row only while it still grants access. The
 * primary is read so a revoke takes effect on the very next request.
 */
export async function resolveAccessToken(
  token: string,
  resourceType: AccessTokenResourceType
): Promise<AccessTokenRow | null> {
  const row = await dbWrite.accessToken.findUnique({
    where: { tokenHash: hashAccessToken(token) },
    select: accessTokenSelect,
  });
  return row && isUsableAccessToken(row, resourceType) ? row : null;
}

export async function getActiveAccessTokens(
  resourceType: AccessTokenResourceType,
  resourceId: number
) {
  return dbWrite.accessToken.findMany({
    where: { resourceType, resourceId, ...activeWhere() },
    select: { id: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: 'desc' },
  });
}

/** The ids, of those given, that have at least one token still granting access. */
export async function getResourceIdsWithActiveAccessTokens(
  resourceType: AccessTokenResourceType,
  resourceIds: number[],
  db: Db = dbWrite
): Promise<Set<number>> {
  if (!resourceIds.length) return new Set();
  const rows = await db.accessToken.findMany({
    where: { resourceType, resourceId: { in: resourceIds }, ...activeWhere() },
    select: { resourceId: true, resourceType: true, expiresAt: true, revokedAt: true },
  });
  return new Set(rows.filter((r) => isUsableAccessToken(r, resourceType)).map((r) => r.resourceId));
}

export async function getAccessTokenById(id: number) {
  return dbWrite.accessToken.findUnique({ where: { id }, select: accessTokenSelect });
}

export async function revokeAccessToken(id: number) {
  await dbWrite.accessToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeActiveAccessTokens(
  resourceType: AccessTokenResourceType,
  resourceId: number,
  db: Db = dbWrite
) {
  await db.accessToken.updateMany({
    where: { resourceType, resourceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
