import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { refreshSession } from '~/server/auth/session-invalidation';
import { isAppAccessRequestAutoApproveEnabled } from '~/server/services/app-blocks-flag';
import { notifyAppAccessDecision } from '~/server/services/app-access-request-notify';
import { dbWrite } from '~/server/db/client';
import type {
  DecideAppAccessRequestInput,
  ListAppAccessRequestsInput,
  SubmitAppAccessRequestInput,
} from '~/server/schema/app-access-request.schema';
import {
  APP_ACCESS_AUTO_APPROVE_REVIEWER_ID,
  type AppAccessRequestStatus,
} from '~/shared/constants/app-access-request.constants';
import { handleLogError } from '~/server/utils/errorHandling';
import type { SessionUser } from '~/types/session';

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
 * Whether the person holds an approved request — the grant the auth hub reads ("EXISTS an approved
 * row"). Read from the primary, like everything here.
 */
async function hasApprovedAppAccessRequest(userId: number): Promise<boolean> {
  const [row] = await dbWrite.$queryRaw<{ approved: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "AppAccessRequest" WHERE "userId" = ${userId} AND "status" = 'approved'
    ) AS "approved"
  `);
  return !!row?.approved;
}

/**
 * Creates the viewer's request. One pending request per person (the partial unique index), so a
 * second submit while one is pending is a CONFLICT; after a decline a new request is a new row.
 *
 * With the `app-access-request-auto-approve` flag on for the requester, the request is recorded as
 * already approved by the system account, unless they have a pending or declined request (so a
 * decline or revoke stays a moderator's call; declined rows are that record, so never prune them) or
 * their account is banned, muted or deleted. Those fall through to a pending request.
 */
export async function submitAppAccessRequest({
  user,
  input,
}: {
  user: SessionUser;
  input: SubmitAppAccessRequestInput;
}): Promise<AppAccessRequestView> {
  const userId = user.id;
  if (await hasApprovedAppAccessRequest(userId))
    throw new TRPCError({ code: 'CONFLICT', message: APP_ACCESS_ALREADY_APPROVED });

  if (await isAppAccessRequestAutoApproveEnabled({ user })) {
    // Standing is read from the User row, not the session, which can be hours old.
    const [approved] = await dbWrite.$queryRaw<AppAccessRequestView[]>(Prisma.sql`
      INSERT INTO "AppAccessRequest" ("userId", "whatToBuild", "status", "reviewedAt", "reviewedById")
      SELECT u."id", ${input.whatToBuild}, 'approved', CURRENT_TIMESTAMP, ${APP_ACCESS_AUTO_APPROVE_REVIEWER_ID}
      FROM "User" u
      WHERE u."id" = ${userId}
        AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL AND NOT u."muted"
        AND NOT EXISTS (
          SELECT 1 FROM "AppAccessRequest"
          WHERE "userId" = ${userId} AND "status" IN ('pending', 'declined')
        )
      RETURNING ${VIEW_COLUMNS}
    `);
    if (approved) {
      // After the INSERT has committed, best-effort, as in `decide`.
      await refreshSession(userId, { caller: 'moderation' }).catch(handleLogError);
      try {
        await notifyAppAccessDecision({
          userId,
          requestId: approved.id,
          decision: 'approved',
          revoked: false,
        });
      } catch (e) {
        handleLogError(e as Error);
      }
      return approved;
    }
  }

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

/**
 * How many requests are waiting for a decision — the `/apps/review` tab badge. A count rather than
 * a page of rows, because the badge polls on every tab. `::int` because Postgres `COUNT` is a
 * bigint, which the driver hands back as a `BigInt` rather than the `number` the badge renders.
 */
export async function countPendingAppAccessRequests(): Promise<number> {
  const [row] = await dbWrite.$queryRaw<{ count: number }[]>(Prisma.sql`
    SELECT COUNT(*)::int AS "count" FROM "AppAccessRequest" WHERE "status" = 'pending'
  `);
  return row?.count ?? 0;
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
 * Then busts the requester's session, because the grant rides on it (see the file comment), and
 * notifies the requester of the outcome. Both run only when THIS call moved the row, after the
 * UPDATE has committed, and both are best-effort: a failed bust is bounded by the session TTL, and
 * a failed notification is logged and never fails or undoes the decision.
 */
export async function decideAppAccessRequest({
  moderatorId,
  input,
}: {
  moderatorId: number;
  input: DecideAppAccessRequestInput;
}): Promise<AppAccessRequestView> {
  const from = DECIDABLE_FROM[input.decision];
  // 🔴 A REVOKE DECLINES EVERY APPROVED ROW THE PERSON HOLDS, not just the one clicked. Two can
  // exist: `submit`'s approved-check and its INSERT are separate statements, so a submit racing an
  // approve leaves a second pending row a moderator may also approve. The grant is "EXISTS an
  // approved row", so a one-row revoke would leave access in place. The sweep runs only when the
  // TARGET was approved: declining a stray pending row must not take away a standing grant.
  // (Chosen over a partial unique index on approved rows: that would make approving the stray row
  // a unique violation, and the migration is hand-applied with IF NOT EXISTS, so an environment
  // that already ran it would never get the index.)
  const rows = await dbWrite.$queryRaw<
    (AppAccessRequestView & { userId: number; prev: AppAccessRequestStatus })[]
  >(Prisma.sql`
    WITH target AS (
      SELECT "id", "userId", "status" AS "prev" FROM "AppAccessRequest"
      WHERE "id" = ${input.id} AND "status" IN (${Prisma.join(from)})
      FOR UPDATE
    )
    UPDATE "AppAccessRequest" r
    SET "status" = ${input.decision},
        "reviewedAt" = CURRENT_TIMESTAMP,
        "reviewedById" = ${moderatorId}
    FROM target t
    WHERE r."id" = t."id"
       OR (t."prev" = 'approved' AND r."userId" = t."userId" AND r."status" = 'approved')
    RETURNING r."userId", r."id", r."whatToBuild", r."status", r."createdAt", r."reviewedAt",
              t."prev"
  `);
  const row = rows.find((r) => r.id === input.id);
  if (row) {
    const { userId, prev, ...view } = row;
    await refreshSession(userId, { caller: 'moderation' }).catch(handleLogError);
    // Once per decision, for the clicked row only — a revoke sweep that also declined a second
    // approved row is still one decision to the person. try/catch rather than `.catch`: a
    // synchronous throw must not escape either.
    try {
      // Declining a stray PENDING row (the race above) leaves a standing grant in place, so a
      // "not approved" notice would be false. Read after the commit, so it sees this decision.
      if (
        input.decision === 'declined' &&
        prev === 'pending' &&
        (await hasApprovedAppAccessRequest(userId))
      )
        return view;
      await notifyAppAccessDecision({
        userId,
        requestId: view.id,
        decision: input.decision,
        revoked: prev === 'approved',
      });
    } catch (e) {
      handleLogError(e as Error);
    }
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
