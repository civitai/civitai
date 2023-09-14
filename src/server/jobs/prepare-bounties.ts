import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';
import dayjs from 'dayjs';
import { Currency } from '@prisma/client';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';

const log = createLogger('bounties', 'blue');

const prepareBounties = createJob('prepare-bounties', '0 1 * * *', async () => {
  const [lastRun, setLastRun] = await getJobDate('prepare-bounties');

  const bounties = await dbWrite.bounty.findMany({
    where: {
      complete: false,
      expiresAt: {
        lt: dayjs().subtract(1, 'day').endOf('day').toDate(),
      },
    },
    select: {
      id: true,
      userId: true,
    },
  });

  // Get latest results for date
  for (const { id, userId } of bounties) {
    log(`Started bounty ${id}`);
    const [mainBenefactor] = await dbWrite.$queryRaw<
      {
        currency: Currency;
      }[]
    >`SELECT currency FROM "BountyBenefactor" bf WHERE bf."bountyId" = ${id} AND bf."userId" = ${userId} LIMIT 1; `;

    const { currency } = mainBenefactor;

    log('got currency: ', currency);

    // TODO.bounty: Need to check stats in case awardedUnitAmount is equal on multiple items.
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
      console.log('no winners :( returning monys');
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
                type: TransactionType.Bounty,
                description: 'Reason: Bounty refund, no entries found on bounty',
              });

              break;
            default: // Do no checks
              break;
          }
        }
      }

      await dbWrite.$executeRawUnsafe(` 
        UPDATE "Bounty" b SET "complete" = true WHERE b.id = ${id};
      `);
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
      `A total of ${awardedAmount} ${currency} will be awarded in this bounty to the entry ${winnerEntryId}`
    );

    await dbWrite.$transaction([
      dbWrite.$executeRawUnsafe(`
        UPDATE "BountyBenefactor" bf SET "awardedToId" = ${winnerEntryId} WHERE bf."bountyId" = ${id} AND bf."awardedToId" IS NULL;
      `),
      dbWrite.$executeRawUnsafe(` 
        UPDATE "Bounty" b SET "complete" = true WHERE b.id = ${id};
      `),
    ]);

    if (awardedAmount > 0) {
      switch (currency) {
        case Currency.BUZZ:
          await createBuzzTransaction({
            fromAccountId: 0,
            toAccountId: winnerUserId,
            amount: awardedAmount,
            type: TransactionType.Bounty,
            description: 'Reason: Bounty entry has been awarded!',
          });

          break;
        default: // Do no checks
          break;
      }
    }

    // Now
    log(`Finished bounty ${id}`);
  }

  await setLastRun();
});

export const bountyJobs = [prepareBounties];
