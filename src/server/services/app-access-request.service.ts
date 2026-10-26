import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import type {
  DecideAppAccessRequestInput,
  ListAppAccessRequestsInput,
  SubmitAppAccessRequestInput,
} from '~/server/schema/app-access-request.schema';
import type { AppAccessRequestStatus } from '~/shared/constants/app-access-request.constants';

/**
 * "Request access" from the `/apps/build` pitch, and the moderator queue that reviews it.
 *
 * A decision is a RECORD, not a grant: approving writes `approved` and nothing else. Who can build
 * is still decided by feature flags, which a person changes by hand after approving.
 *
 * Raw SQL rather than the Prisma model API because the one-pending-per-user rule lives in a PARTIAL
 * unique index (`AppAccessRequest_userId_pending_key`), and only `ON CONFLICT … WHERE` can target
 * it. Every read goes to the primary: a person reloads straight after submitting, and a moderator
 * re-reads the queue straight after deciding, so a lagging replica would show the old state.
 */

export const APP_ACCESS_ALREADY_APPROVED =
  'Your request was already approved. Access is switched on by hand, so it can take a little while.';

export type AppAccessRequestView = {
  id: number;
  whatToBuild: string;
  links: string[];
  status: AppAccessRequestStatus;
  createdAt: Date;
  updatedAt: Date;
  reviewedAt: Date | null;
};

export type AppAccessRequestQueueItem = AppAccessRequestView & {
  userId: number;
  username: string | null;
  reviewedById: number | null;
  reviewedByUsername: string | null;
};

const VIEW_COLUMNS = Prisma.raw(
  `"id", "whatToBuild", "links", "status", "createdAt", "updatedAt", "reviewedAt"`
);

/**
 * Creates the viewer's pending request, or updates it if they already have one. A request that was
 * declined leaves room for a new one; an approved one does not.
 */
export async function submitAppAccessRequest({
  userId,
  input,
}: {
  userId: number;
  input: SubmitAppAccessRequestInput;
}): Promise<AppAccessRequestView> {
  const approved = await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    SELECT "id" FROM "AppAccessRequest"
    WHERE "userId" = ${userId} AND "status" = 'approved'
    LIMIT 1
  `);
  if (approved.length > 0)
    throw new TRPCError({ code: 'CONFLICT', message: APP_ACCESS_ALREADY_APPROVED });

  const [row] = await dbWrite.$queryRaw<AppAccessRequestView[]>(Prisma.sql`
    INSERT INTO "AppAccessRequest" ("userId", "whatToBuild", "links")
    VALUES (${userId}, ${input.whatToBuild}, ${input.links}::text[])
    ON CONFLICT ("userId") WHERE "status" = 'pending'
    DO UPDATE SET
      "whatToBuild" = EXCLUDED."whatToBuild",
      "links" = EXCLUDED."links",
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING ${VIEW_COLUMNS}
  `);
  return row;
}

/** The viewer's latest request, or null when they have never sent one. */
export async function getMyAppAccessRequest({
  userId,
}: {
  userId: number;
}): Promise<AppAccessRequestView | null> {
  const [row] = await dbWrite.$queryRaw<AppAccessRequestView[]>(Prisma.sql`
    SELECT ${VIEW_COLUMNS} FROM "AppAccessRequest"
    WHERE "userId" = ${userId}
    ORDER BY "id" DESC
    LIMIT 1
  `);
  return row ?? null;
}

/** The moderator queue, newest first, keyed on the row id so paging never compares timestamps. */
export async function listAppAccessRequests(
  input: ListAppAccessRequestsInput
): Promise<{ items: AppAccessRequestQueueItem[]; nextCursor: number | null }> {
  const status = input.status ? Prisma.sql`AND r."status" = ${input.status}` : Prisma.empty;
  const cursor = input.cursor ? Prisma.sql`AND r."id" < ${input.cursor}` : Prisma.empty;
  const rows = await dbWrite.$queryRaw<AppAccessRequestQueueItem[]>(Prisma.sql`
    SELECT
      r."id", r."userId", u."username", r."whatToBuild", r."links", r."status",
      r."createdAt", r."updatedAt", r."reviewedAt", r."reviewedById",
      rv."username" AS "reviewedByUsername"
    FROM "AppAccessRequest" r
    JOIN "User" u ON u."id" = r."userId"
    LEFT JOIN "User" rv ON rv."id" = r."reviewedById"
    WHERE TRUE ${status} ${cursor}
    ORDER BY r."id" DESC
    LIMIT ${input.limit + 1}
  `);
  const hasMore = rows.length > input.limit;
  const items = hasMore ? rows.slice(0, input.limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

/**
 * Records a moderator's decision on a PENDING request. A decided request is not re-decided here:
 * two moderators acting on one row get one decision and one CONFLICT, not a silent overwrite.
 */
export async function decideAppAccessRequest({
  moderatorId,
  input,
}: {
  moderatorId: number;
  input: DecideAppAccessRequestInput;
}): Promise<AppAccessRequestView> {
  const [row] = await dbWrite.$queryRaw<AppAccessRequestView[]>(Prisma.sql`
    UPDATE "AppAccessRequest"
    SET "status" = ${input.decision},
        "reviewedAt" = CURRENT_TIMESTAMP,
        "reviewedById" = ${moderatorId},
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${input.id} AND "status" = 'pending'
    RETURNING ${VIEW_COLUMNS}
  `);
  if (row) return row;

  const [existing] = await dbWrite.$queryRaw<{ status: AppAccessRequestStatus }[]>(Prisma.sql`
    SELECT "status" FROM "AppAccessRequest" WHERE "id" = ${input.id}
  `);
  if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such access request.' });
  throw new TRPCError({
    code: 'CONFLICT',
    message: `This request was already ${existing.status}.`,
  });
}
