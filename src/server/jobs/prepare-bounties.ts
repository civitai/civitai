import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';
import dayjs from '~/shared/utils/dayjs';
import { Currency } from '~/shared/utils/prisma/enums';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';
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
  for (const { id, userId, user, name, _count } of justExpiredBounties) {
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

  for (const { id, userId, user, name } of needReminderBounties) {
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
    log(`Started bounty ${id}`);
    const [mainBenefactor] = await dbWrite.$queryRaw<
      {
        currency: Currency;
      }[]
    >`SELECT currency FROM "BountyBenefactor" bf WHERE bf."bountyId" = ${id} AND bf."userId" = ${userId} LIMIT 1; `;

    const { currency } = mainBenefactor;
    log(" Bounty's main currency detected:", currency);

    const [winnerEntry] = await dbWrite.$queryRaw<
      {
        id: number;
        userId: number;
      }[]
    >`SELECT
          be.id,
          be."userId",
          COALESCE(SUM(bb."unitAmount"), 0) AS "awardedUnitAmount",
          bes."reactionCountAllTime" AS "reactionCountAllTime"
      FROM "BountyEntry" be
      LEFT JOIN "BountyEntryStat" bes on bes."bountyEntryId" = be.id
      LEFT JOIN "BountyBenefactor" bb ON bb."awardedToId" = be.id AND bb.currency = ${currency}::"Currency"
      WHERE be."bountyId" = ${id}
      GROUP BY be.id, be."userId", bes."reactionCountAllTime"
      ORDER BY "awardedUnitAmount" DESC, "reactionCountAllTime" DESC, be.id ASC LIMIT 1
    `;

    if (!winnerEntry) {
      // Return unawarded funds to benefactors
      const benefactors = await dbWrite.$queryRaw<
        {
          userId: number;
          unitAmount: number;
        }[]
      >`SELECT
            bf."userId",
            bf."unitAmount"
        FROM "BountyBenefactor" bf
        WHERE bf."bountyId" = ${id}
          AND bf.currency = ${currency}::"Currency"
          AND bf."awardedToId" IS NULL;
      `;

      // Now refund each of them:
      for (const { userId, unitAmount } of benefactors) {
        if (unitAmount > 0) {
          switch (currency) {
            case Currency.BUZZ:
              await createBuzzTransaction({
                fromAccountId: 0,
                toAccountId: userId,
                amount: unitAmount,
                type: TransactionType.Refund,
                description: 'Reason: Bounty refund, no entries found on bounty',
              });

              break;
            default: // Do no checks
              break;
          }
        }
      }

      await dbWrite.$executeRawUnsafe(`
        UPDATE "Bounty" b SET "complete" = true, "refunded" = true WHERE b.id = ${id};
      `);

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
      continue;
    }

    const { id: winnerEntryId, userId: winnerUserId } = winnerEntry;

    const benefactors = await dbWrite.$queryRaw<
      {
        userId: number;
        unitAmount: number;
      }[]
    >`SELECT
          bf."userId",
          bf."unitAmount"
      FROM "BountyBenefactor" bf
      WHERE bf."bountyId" = ${id}
        AND bf.currency = ${currency}::"Currency"
        AND bf."awardedToId" IS NULL;
    `;

    const awardedAmount = benefactors.reduce((acc, { unitAmount }) => acc + unitAmount, 0);

    log(
      ` A total of ${awardedAmount} ${currency} will be awarded in this bounty to the entry ${winnerEntryId}`
    );

    await dbWrite.$transaction([
      dbWrite.$executeRawUnsafe(`
        UPDATE "BountyBenefactor" bf SET "awardedToId" = ${winnerEntryId} WHERE bf."bountyId" = ${id} AND bf."awardedToId" IS NULL;
      `),
      dbWrite.$executeRawUnsafe(`
        UPDATE "Bounty" b SET "complete" = true WHERE b.id = ${id};
      `),
    ]);
    tracker
      .bountyEntry({ type: 'Award', bountyEntryId: winnerEntryId, userId: -1 })
      .catch(handleLogError);

    if (awardedAmount > 0) {
      switch (currency) {
        case Currency.BUZZ:
          await createBuzzTransaction({
            fromAccountId: 0,
            toAccountId: winnerUserId,
            amount: awardedAmount,
            type: TransactionType.Bounty,
            description: 'Reason: Bounty entry has been awarded!',
            details: {
              entityId: id,
              entityType: 'Bounty',
            },
          });

          break;
        default: // Do no checks
          break;
      }
    }

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
    // Now
    log(`Finished bounty ${id}`);
  }

  await setLastRun();
});

export const bountyJobs = [prepareBounties];
