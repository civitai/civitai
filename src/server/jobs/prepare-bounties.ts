import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';
import dayjs from '~/shared/utils/dayjs';
import type { Currency } from '~/shared/utils/prisma/enums';
import { Tracker } from '../clickhouse/client';
import { handleLogError } from '../utils/errorHandling';
import {
  bountyAutomaticallyAwardedEmail,
  bountyExpiredEmail,
  bountyExpiredReminderEmail,
  bountyRefundedEmail,
} from '~/server/email/templates';
import { bountiesSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { logToAxiom } from '~/server/logging/client';
import { retryUnsettledBountyPayouts, settleBountyPayout } from '~/server/services/bounty.service';
import { lockBountyForPayout } from '~/server/services/bounty-payout-lock';
import { isTextScanPoiHidden } from '~/server/services/text-scan/flag-snapshot';

const log = createLogger('prepare-bounties', 'blue');

const logJob = (data: MixedObject) => {
  logToAxiom({ name: 'prepare-bounties', type: 'error', ...data }, 'webhooks').catch();
};

const prepareBounties = createJob('prepare-bounties', '0 23 * * *', async () => {
  const [lastRun, setLastRun] = await getJobDate('prepare-bounties');
  const justExpiredBounties = await dbWrite.bounty.findMany({
    where: {
      complete: false,
      // Expires today
      expiresAt: dayjs().toDate(),
      userId: { not: null },
      user: {
        email: { not: null },
      },
      entries: {
        some: {},
      },
    },
    select: {
      id: true,
      name: true,
      userId: true,
      poi: true,
      availability: true,
      meta: true,
      user: {
        select: {
          id: true,
          email: true,
        },
      },
      _count: {
        select: {
          entries: true,
        },
      },
    },
  });

  log(
    'justExpiredBounties IDs',
    justExpiredBounties.map((b) => b.id)
  );

  // send emails to just expired bounties:
  for (const { id, userId, user, name, _count, ...state } of justExpiredBounties) {
    if (isTextScanPoiHidden(state)) continue;
    log('Sending bounty expired reminder to ', userId);
    if (user?.email) {
      bountyExpiredEmail
        .send({
          bounty: { id, name, entryCount: _count.entries ?? 0 },
          user: { email: user.email },
        })
        .catch((error) =>
          logJob({
            message: 'Error sending bounty expired email',
            data: {
              email: user.email,
              bountyId: id,
              error: error.message,
              cause: error.cause,
              stack: error.stack,
            },
          })
        );
    }
  }

  const needReminderBounties = await dbWrite.bounty.findMany({
    where: {
      complete: false,
      expiresAt: dayjs().subtract(1, 'day').toDate(),
      entries: {
        some: {},
      },
    },
    select: {
      id: true,
      userId: true,
      name: true,
      poi: true,
      availability: true,
      meta: true,
      user: {
        select: {
          id: true,
          username: true,
          email: true,
        },
      },
    },
  });

  log(
    'needReminderBounties IDs',
    needReminderBounties.map((b) => b.id)
  );

  for (const { id, userId, user, name, ...state } of needReminderBounties) {
    if (isTextScanPoiHidden(state)) continue;
    log('Sending bounty expired reminder to ', userId);
    if (user?.email && user?.username) {
      bountyExpiredReminderEmail
        .send({
          bounty: { id, name },
          user: { username: user.username, email: user.email },
        })
        .catch((error) =>
          logJob({
            message: 'Error sending bounty expired reminder email',
            data: {
              username: user.username,
              email: user.email,
              bountyId: id,
              error: error.message,
              cause: error.cause,
              stack: error.stack,
            },
          })
        );
    }
  }

  const bounties = await dbWrite.bounty.findMany({
    where: {
      AND: [
        {
          complete: false,
        },
        {
          OR: [
            {
              expiresAt: {
                lte: dayjs().subtract(2, 'day').toDate(),
              },
              entries: { some: {} },
            },
            // If no entries, mark as complete and refund
            {
              expiresAt: {
                lte: dayjs().toDate(),
              },
              entries: { none: {} },
            },
          ],
        },
      ],
    },
    select: {
      id: true,
      userId: true,
      name: true,
      user: {
        select: {
          id: true,
          email: true,
        },
      },
    },
  });

  log(
    'awardOrRefundBounties IDs',
    bounties.map((b) => b.id)
  );

  const tracker = new Tracker();

  // Get latest results for date
  for (const { id, userId, name, user } of bounties) {
    try {
      await settleExpiredBounty({ id, userId, name, user, tracker });
    } catch (error) {
      // One bounty must not stop the sweep, or every later bounty waits for the next run.
      logJob({
        message: 'Failed to settle expired bounty',
        data: { bountyId: id, error: (error as Error).message },
      });
    }
  }

  await setLastRun();
});

async function settleExpiredBounty({
  id,
  userId,
  name,
  user,
  tracker,
}: {
  id: number;
  userId: number | null;
  name: string;
  user: { id: number; email: string | null } | null;
  tracker: Tracker;
}) {
  log(`Started bounty ${id}`);
  // Claimed under the payout lock; a bounty a refund or manual award already claimed
  // is left alone. Buzz moves only after the claim commits.
  const claim = await dbWrite.$transaction(async (tx) => {
    const locked = await lockBountyForPayout(tx, id);
    if (!locked || locked.complete || locked.refunded) return null;

    const [mainBenefactor] = await tx.$queryRaw<{ currency: Currency }[]>`
        SELECT currency FROM "BountyBenefactor" bf WHERE bf."bountyId" = ${id} AND bf."userId" = ${userId} LIMIT 1;
      `;
    if (!mainBenefactor) return null;
    const { currency } = mainBenefactor;

    if (isTextScanPoiHidden(locked)) {
      await tx.$executeRawUnsafe(`
          UPDATE "Bounty" b SET "complete" = true, "refunded" = true, "payoutRecordedAt" = NOW() WHERE b.id = ${id};
        `);
      return { kind: 'refund' as const, currency, poiHidden: true };
    }

    const [winnerEntry] = await tx.$queryRaw<{ id: number; userId: number }[]>`SELECT
            be.id,
            be."userId",
            COALESCE(SUM(bb."unitAmount"), 0) AS "awardedUnitAmount",
            bes."reactionCountAllTime" AS "reactionCountAllTime"
        FROM "BountyEntry" be
        LEFT JOIN "BountyEntryStat" bes on bes."bountyEntryId" = be.id
        LEFT JOIN "BountyBenefactor" bb ON bb."awardedToId" = be.id AND bb.currency = ${currency}::"Currency"
        WHERE be."bountyId" = ${id} AND be."userId" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "BountyBenefactor" own
            WHERE own."bountyId" = ${id}
              AND own."userId" = be."userId"
              AND own.currency = ${currency}::"Currency"
              AND own."awardedToId" IS NULL
          )
          AND be."userId" IS DISTINCT FROM ${userId}
        GROUP BY be.id, be."userId", bes."reactionCountAllTime"
        ORDER BY "awardedUnitAmount" DESC, "reactionCountAllTime" DESC, be.id ASC LIMIT 1
      `;

    if (!winnerEntry) {
      await tx.$executeRawUnsafe(`
          UPDATE "Bounty" b SET "complete" = true, "refunded" = true, "payoutRecordedAt" = NOW() WHERE b.id = ${id};
        `);
      return { kind: 'refund' as const, currency, poiHidden: false };
    }

    // Settlement pays from these marks; see the invariant on `refundUnpayableBountyAward`.
    await tx.$executeRawUnsafe(`
        UPDATE "BountyBenefactor" bf SET "awardedToId" = ${winnerEntry.id}, "awardedAt" = NOW() WHERE bf."bountyId" = ${id} AND bf."awardedToId" IS NULL;
      `);
    await tx.$executeRawUnsafe(`
        UPDATE "Bounty" b SET "complete" = true, "payoutRecordedAt" = NOW(), "payoutWinnerUserId" = ${winnerEntry.userId} WHERE b.id = ${id};
      `);
    return { kind: 'award' as const, currency, winnerEntry };
  });

  if (!claim) {
    log(` Bounty ${id} was already claimed; skipped`);
    return;
  }
  log(" Bounty's main currency detected:", claim.currency);

  if (claim.kind === 'refund') {
    await settleBountyPayout(id, {
      firstAttempt: true,
      refundDescription: claim.poiHidden
        ? 'Reason: Bounty refund, bounty hidden pending review'
        : 'Reason: Bounty refund, no entries found on bounty',
    });
    if (claim.poiHidden)
      logToAxiom(
        {
          name: 'prepare-bounties',
          type: 'info',
          message: 'poi-hidden bounty refunded at expiry',
          bountyId: id,
        },
        'webhooks'
      ).catch();

    if (user) {
      bountyRefundedEmail
        .send({
          bounty: { id, name },
          user: { email: user.email },
        })
        .catch((error) =>
          logJob({
            message: 'Error sending bounty refunded email',
            data: {
              email: user.email,
              bountyId: id,
              error: error.message,
              cause: error.cause,
              stack: error.stack,
            },
          })
        );
    }

    tracker.bounty({ type: 'Expire', bountyId: id, userId: -1 }).catch(handleLogError);
    log(` No entry winner detected, bounty has been refunded`);
    return;
  }

  const winnerEntryId = claim.winnerEntry.id;
  tracker
    .bountyEntry({ type: 'Award', bountyEntryId: winnerEntryId, userId: -1 })
    .catch(handleLogError);

  if (!(await settleBountyPayout(id, { firstAttempt: true })))
    logJob({
      message: 'Bounty awarded but the Buzz payout failed; the retry job pays it',
      data: { bountyId: id, winnerEntryId },
    });

  await bountiesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);

  if (user) {
    bountyAutomaticallyAwardedEmail
      .send({
        bounty: { id, name },
        entry: { id: winnerEntryId },
        user: { email: user.email },
      })
      .catch((error) =>
        logJob({
          message: 'Error sending bounty awarded email',
          data: {
            email: user.email,
            bountyId: id,
            error: error.message,
            cause: error.cause,
            stack: error.stack,
          },
        })
      );
  }
  log(`Finished bounty ${id}`);
}

const bountyPayoutRetry = createJob('bounty-payout-retry', '41 * * * *', async () =>
  retryUnsettledBountyPayouts()
);

export const bountyJobs = [prepareBounties, bountyPayoutRetry];
