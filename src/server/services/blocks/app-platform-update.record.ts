/**
 * The `app_platform_updates` RECORD: its row shape, its one read, and a moderator's supersede.
 * Split out of `app-platform-update.service.ts` (which re-exports all of it) so a caller that
 * only withdraws an update, `publish-request.service` on the reject of a staff on-behalf submit,
 * does not import the push/resolve half and the source-repo and access services behind it: through
 * them `app-platform-update.service` joined `publish-request.service`'s import cycle. This module
 * imports nothing from that cycle; keep it that way (`no-import-cycle-growth.test.ts`).
 */

import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { isMissingTableError } from '~/server/services/blocks/missing-table-error';

export type PlatformUpdateStatus = 'pending' | 'merged' | 'conflicted' | 'superseded';

export type PlatformUpdatePath = { path: string; operation: 'create' | 'update' | 'delete' };

export const platformUpdateLog = (
  type: 'info' | 'warning' | 'error',
  message: string,
  data: Record<string, unknown>
) => logToAxiom({ name: 'app-platform-update', type, message, ...data }, 'webhooks');

export const platformUpdatesUnavailable = () =>
  new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Platform updates are not available' });

export type UpdateRow = {
  id: string;
  appBlockId: string;
  slug: string;
  staffUserId: number;
  reason: string;
  branch: string;
  baseCommitSha: string;
  commitSha: string;
  paths: PlatformUpdatePath[];
  touchesManifest: boolean;
  status: PlatformUpdateStatus;
  mergeCommitSha: string | null;
  seededSourceRepo: boolean;
  createdAt: Date;
  resolvedAt: Date | null;
  /** The staff account as it is NOW (joined at read time); null when it no longer exists. */
  staffUsername: string | null;
  staffIsModerator: boolean | null;
  staffBannedAt: Date | null;
  staffDeletedAt: Date | null;
};

const ROW_COLUMNS = Prisma.sql`u."id", u."app_block_id" AS "appBlockId", u."slug",
  u."staff_user_id" AS "staffUserId", u."reason", u."branch",
  u."base_commit_sha" AS "baseCommitSha", u."commit_sha" AS "commitSha", u."paths",
  u."touches_manifest" AS "touchesManifest", u."status",
  u."merge_commit_sha" AS "mergeCommitSha", u."seeded_source_repo" AS "seededSourceRepo",
  u."created_at" AS "createdAt", u."resolved_at" AS "resolvedAt",
  s."username" AS "staffUsername", s."isModerator" AS "staffIsModerator",
  s."bannedAt" AS "staffBannedAt", s."deletedAt" AS "staffDeletedAt"`;

export type RowFilter =
  | { kind: 'open-for-app'; appBlockId: string }
  | { kind: 'all-for-app'; appBlockId: string }
  | { kind: 'commit'; appBlockId: string; commitSha: string }
  | { kind: 'id'; id: string };

function filterSql(filter: RowFilter): Prisma.Sql {
  switch (filter.kind) {
    case 'id':
      return Prisma.sql`WHERE u."id" = ${filter.id} LIMIT 1`;
    case 'commit':
      return Prisma.sql`WHERE u."app_block_id" = ${filter.appBlockId}
        AND u."commit_sha" = ${filter.commitSha} LIMIT 1`;
    case 'open-for-app':
      return Prisma.sql`WHERE u."app_block_id" = ${filter.appBlockId}
        AND u."status" IN ('pending', 'conflicted')
        ORDER BY u."created_at" ASC, u."id" ASC LIMIT 100`;
    case 'all-for-app':
      return Prisma.sql`WHERE u."app_block_id" = ${filter.appBlockId}
        ORDER BY u."created_at" DESC, u."id" DESC LIMIT 200`;
  }
}

/**
 * Rows matching `filter`, each joined to its staff account as it is NOW; `null` when the table is
 * missing.
 */
export async function readRows(
  filter: RowFilter,
  db: Pick<typeof dbRead, '$queryRaw'> = dbRead
): Promise<UpdateRow[] | null> {
  try {
    return (await db.$queryRaw(
      Prisma.sql`SELECT ${ROW_COLUMNS}
        FROM "app_platform_updates" u LEFT JOIN "User" s ON s."id" = u."staff_user_id"
        ${filterSql(filter)}`
    )) as UpdateRow[];
  } catch (err) {
    if (isMissingTableError(err)) return null;
    throw err;
  }
}

/** A moderator withdraws an update that is still pending (or conflicted): `superseded`. */
export async function supersedePlatformUpdate(args: {
  staffUserId: number;
  id: string;
}): Promise<{ id: string; status: 'superseded' }> {
  // The primary: an update pushed moments ago may not have reached the replica.
  const rows = await readRows({ kind: 'id', id: args.id }, dbWrite);
  if (rows === null) throw platformUpdatesUnavailable();
  const row = rows[0];
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Update not found' });
  if (row.status === 'superseded') return { id: row.id, status: 'superseded' };
  const changed = Number(
    await dbWrite.$executeRaw`UPDATE "app_platform_updates"
        SET "status" = 'superseded', "resolved_by_user_id" = ${args.staffUserId},
            "resolved_at" = now(), "updated_at" = now()
      WHERE "id" = ${row.id} AND "status" IN ('pending', 'conflicted')`
  );
  if (changed !== 1)
    throw new TRPCError({ code: 'CONFLICT', message: `This update is already ${row.status}` });
  platformUpdateLog('info', 'superseded', {
    updateId: row.id,
    slug: row.slug,
    staffUserId: args.staffUserId,
  });
  return { id: row.id, status: 'superseded' };
}
