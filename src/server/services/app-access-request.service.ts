import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { refreshSession } from '~/server/auth/session-invalidation';
import { dbWrite } from '~/server/db/client';
import type {
  DecideAppAccessRequestInput,
  ListAppAccessRequestsInput,
  SubmitAppAccessRequestInput,
} from '~/server/schema/app-access-request.schema';
import type { AppAccessRequestStatus } from '~/shared/constants/app-access-request.constants';
import { handleLogError } from '~/server/utils/errorHandling';

/**
 * "Request access" from the `/apps/build` pitch, and the moderator queue that reviews it.
 *
 * 🔴 AN `approved` ROW IS THE GRANT. The auth hub's session producer reads "has an approved row"
 * into `SessionUser.appBuilderApproved`, `buildFliptContext` emits it as the `appBuilderApproved`
 * targeting property, and the `app-builder-approved` Flipt segment puts that user on the builder
 * flags (App Assistant included). So `decide` busts the REQUESTER's cached session after it writes:
 * without that, the hub keeps serving the old value for up to its 4h TTL and an approval (or a
 * revoke) changes nothing until then.
 *
 * Raw SQL rather than the Prisma model API because the one-pending-per-user rule lives in a PARTIAL
 * unique index (`AppAccessRequest_userId_pending_key`), and only `ON CONFLICT … WHERE` can target
 * it. Every read goes to the primary: a person reloads straight after submitting, and a moderator
 * re-reads the queue straight after deciding, so a lagging replica would show the old state.
 */

export const APP_ACCESS_ALREADY_APPROVED = 'You already have access to build apps.';
export const APP_ACCESS_ALREADY_PENDING = 'Your request is waiting for review.';

export type AppAccessRequestView = {
  id: number;
  whatToBuild: string;
  status: AppAccessRequestStatus;
  createdAt: Date;
  reviewedAt: Date | null;
};

export type AppAccessRequestQueueItem = AppAccessRequestView & {
  userId: number;
  username: string | null;
  reviewedById: number | null;
  reviewedByUsername: string | null;
};

const VIEW_COLUMNS = Prisma.raw(`"id", "whatToBuild", "status", "createdAt", "reviewedAt"`);

/**
 * Creates the viewer's request. One pending request per person (the partial unique index), so a
 * second submit while one is pending is a CONFLICT; after a decline a new request is a new row.
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
    INSERT INTO "AppAccessRequest" ("userId", "whatToBuild")
    VALUES (${userId}, ${input.whatToBuild})
    ON CONFLICT ("userId") WHERE "status" = 'pending' DO NOTHING
    RETURNING ${VIEW_COLUMNS}
  `);
  if (!row) throw new TRPCError({ code: 'CONFLICT', message: APP_ACCESS_ALREADY_PENDING });
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
      r."id", r."userId", u."username", r."whatToBuild", r."status",
      r."createdAt", r."reviewedAt", r."reviewedById",
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

/** The statuses each decision may replace. Declining an approved row is the revoke. */
const DECIDABLE_FROM: Record<DecideAppAccessRequestInput['decision'], AppAccessRequestStatus[]> = {
  approved: ['pending'],
  declined: ['pending', 'approved'],
};

/**
 * Records a moderator's decision. Allowed moves: pending → approved, pending → declined, and
 * approved → declined (a revoke). Anything else — a second approve, re-deciding a declined row —
 * is a CONFLICT, so two moderators acting on one row get one decision, not a silent overwrite.
 *
 * Then busts the requester's session, because the grant rides on it (see the file comment).
 * Best-effort: the decision has committed, and a failed bust is bounded by the session TTL.
 */
export async function decideAppAccessRequest({
  moderatorId,
  input,
}: {
  moderatorId: number;
  input: DecideAppAccessRequestInput;
}): Promise<AppAccessRequestView> {
  const from = DECIDABLE_FROM[input.decision];
  const [row] = await dbWrite.$queryRaw<(AppAccessRequestView & { userId: number })[]>(Prisma.sql`
    UPDATE "AppAccessRequest"
    SET "status" = ${input.decision},
        "reviewedAt" = CURRENT_TIMESTAMP,
        "reviewedById" = ${moderatorId}
    WHERE "id" = ${input.id} AND "status" IN (${Prisma.join(from)})
    RETURNING "userId", ${VIEW_COLUMNS}
  `);
  if (row) {
    const { userId, ...view } = row;
    await refreshSession(userId, { caller: 'moderation' }).catch(handleLogError);
    return view;
  }

  const [existing] = await dbWrite.$queryRaw<{ status: AppAccessRequestStatus }[]>(Prisma.sql`
    SELECT "status" FROM "AppAccessRequest" WHERE "id" = ${input.id}
  `);
  if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such access request.' });
  throw new TRPCError({
    code: 'CONFLICT',
    message: `This request was already ${existing.status}.`,
  });
}
