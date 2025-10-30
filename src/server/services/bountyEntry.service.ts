import { Prisma } from '@prisma/client';
import { Currency } from '~/shared/utils/prisma/enums';
import type {
  BountyEntryFileMeta,
  UpsertBountyEntryInput,
} from '~/server/schema/bounty-entry.schema';
import { TransactionType } from '~/shared/constants/buzz.constants';
import {
  createBuzzTransaction,
  createBuzzTransactionMany,
  getMultiAccountTransactionsByPrefix,
} from '~/server/services/buzz.service';
import { getFilesByEntity, updateEntityFiles } from '~/server/services/file.service';
import {
  createEntityImages,
  invalidateManyImageExistence,
  updateEntityImages,
} from '~/server/services/image.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { dbRead, dbWrite } from '../db/client';
import type { GetByIdInput } from '../schema/base.schema';
import { userContentOverviewCache } from '~/server/redis/caches';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';
import { logToAxiom } from '~/server/logging/client';

export const getEntryById = <TSelect extends Prisma.BountyEntrySelect>({
  input,
  select,
}: {
  input: GetByIdInput;
  select: TSelect;
}) => {
  return dbRead.bountyEntry.findUnique({ where: { id: input.id }, select });
};

export const getAllEntriesByBountyId = <TSelect extends Prisma.BountyEntrySelect>({
  input,
  select,
  sort = 'createdAt',
}: {
  input: {
    bountyId: number;
    userId?: number;
    excludedUserIds?: number[];
    limit?: number;
    cursor?: number;
  };
  select: TSelect;
  sort?: 'createdAt' | 'benefactorCount';
}) => {
  let orderBy: Prisma.BountyEntryOrderByWithRelationInput | undefined;
  const take = (input.limit ?? 20) + 1;

  if (sort === 'createdAt') {
    orderBy = { id: 'desc' };
  } else if (sort === 'benefactorCount') {
    orderBy = {
      benefactors: {
        _count: 'desc',
      },
    };
  } else {
    orderBy = undefined;
  }

  return dbRead.bountyEntry.findMany({
    where: {
      bountyId: input.bountyId,
      userId: input.userId,
      AND: input.excludedUserIds ? [{ userId: { notIn: input.excludedUserIds } }] : undefined,
    },
    cursor: input.cursor ? { id: input.cursor } : undefined,
    take,
    select,
    orderBy,
  });
};

export const getBountyEntryEarnedBuzz = async ({
  ids,
  currency = Currency.BUZZ,
}: {
  ids: number[];
  currency?: Currency;
}) => {
  if (!ids.length) {
    return [];
  }

  const data = await dbRead.$queryRaw<{ id: number; awardedUnitAmount: number }[]>`
    SELECT
        be.id,
        COALESCE(SUM(bb."unitAmount"), 0) AS "awardedUnitAmount"
    FROM "BountyEntry" be
    LEFT JOIN "BountyBenefactor" bb ON bb."awardedToId" = be.id AND bb.currency = ${currency}::"Currency"
    WHERE be.id IN (${Prisma.join(ids)})
    GROUP BY be.id
  `;

  return data;
};

export const upsertBountyEntry = async ({
  id,
  bountyId,
  files,
  ownRights,
  images,
  description,
  userId,
}: UpsertBountyEntryInput & { userId: number }) => {
  if (description) await throwOnBlockedLinkDomain(description);
  return dbWrite.$transaction(async (tx) => {
    if (id) {
      const [awarded] = await getBountyEntryEarnedBuzz({ ids: [id] });

      if (awarded && awarded.awardedUnitAmount > 0) {
        throw throwBadRequestError('Bounty entry has already been awarded and cannot be updated');
      }
      // confirm it exists:
      const entry = await tx.bountyEntry.update({ where: { id }, data: { description } });
      if (!entry) return null;

      if (files) {
        await updateEntityFiles({
          tx,
          entityId: entry.id,
          entityType: 'BountyEntry',
          files,
          ownRights: !!ownRights,
        });
      }

      if (images) {
        await updateEntityImages({
          images,
          tx,
          userId,
          entityId: entry.id,
          entityType: 'BountyEntry',
        });
      }

      return entry;
    } else {
      const entry = await tx.bountyEntry.create({
        data: {
          bountyId,
          userId,
          description,
        },
      });

      if (files) {
        await updateEntityFiles({
          tx,
          entityId: entry.id,
          entityType: 'BountyEntry',
          files,
          ownRights: !!ownRights,
        });
      }

      if (images) {
        await createEntityImages({
          images,
          tx,
          userId,
          entityId: entry.id,
          entityType: 'BountyEntry',
        });
      }

      if (entry.userId) {
        await userContentOverviewCache.bust(entry.userId);
      }

      return entry;
    }
  });
};

export const awardBountyEntry = async ({ id, userId }: { id: number; userId: number }) => {
  const logData = { entryId: id, userId, bountyId: 0 };

  await logToAxiom({
    ...logData,
    name: 'bounty-award',
    type: 'info',
    message: 'Award bounty entry started',
  }).catch(() => null);

  const benefactor = await dbWrite.$transaction(
    async (tx) => {
      // 1. Fetch entry details
      await logToAxiom({
        ...logData,
        name: 'bounty-award',
        type: 'info',
        message: 'Fetching entry details',
      }).catch(() => null);

      const entry = await tx.bountyEntry.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          bountyId: true,
          userId: true,
          bounty: {
            select: {
              complete: true,
            },
          },
        },
      });

      logData.bountyId = entry.bountyId;

      await logToAxiom({
        ...logData,
        name: 'bounty-award',
        type: 'info',
        message: 'Entry found',
        entryUserId: entry.userId,
        bountyComplete: entry.bounty.complete,
      }).catch(() => null);

      // 2. Validate entry has a user
      if (!entry.userId) {
        await logToAxiom({
          ...logData,
          name: 'bounty-award',
          type: 'error',
          message: 'Entry has no user',
        }).catch(() => null);
        throw throwBadRequestError('Entry has no user.');
      }

      // 3. Validate bounty is not already complete
      if (entry.bounty.complete) {
        await logToAxiom({
          ...logData,
          name: 'bounty-award',
          type: 'error',
          message: 'Bounty already complete',
        }).catch(() => null);
        throw throwBadRequestError('Bounty is already complete.');
      }

      // 4. Fetch benefactor details
      await logToAxiom({
        ...logData,
        name: 'bounty-award',
        type: 'info',
        message: 'Fetching benefactor details',
      }).catch(() => null);

      const benefactor = await tx.bountyBenefactor.findUniqueOrThrow({
        where: {
          bountyId_userId: {
            userId,
            bountyId: entry.bountyId,
          },
        },
      });

      await logToAxiom({
        ...logData,
        name: 'bounty-award',
        type: 'info',
        message: 'Benefactor found',
        unitAmount: benefactor.unitAmount,
        currency: benefactor.currency,
        alreadyAwarded: !!benefactor.awardedToId,
        previouslyAwardedEntryId: benefactor.awardedToId,
      }).catch(() => null);

      // 5. Validate benefactor hasn't already awarded
      if (benefactor.awardedToId) {
        await logToAxiom({
          ...logData,
          name: 'bounty-award',
          type: 'error',
          message: 'Benefactor already awarded an entry',
          previouslyAwardedEntryId: benefactor.awardedToId,
        }).catch(() => null);
        throw throwBadRequestError('Supporters have already awarded an entry.');
      }

      // 6. Update benefactor with award
      await logToAxiom({
        ...logData,
        name: 'bounty-award',
        type: 'info',
        message: 'Updating benefactor with award',
      }).catch(() => null);

      const updatedBenefactor = await tx.bountyBenefactor.update({
        where: {
          bountyId_userId: {
            userId,
            bountyId: entry.bountyId,
          },
        },
        data: {
          awardedToId: entry.id,
          awardedAt: new Date(),
        },
      });

      await logToAxiom({
        ...logData,
        name: 'bounty-award',
        type: 'info',
        message: 'Benefactor updated successfully',
      }).catch(() => null);

      // 7. Create buzz transaction
      await logToAxiom({
        ...logData,
        name: 'bounty-award',
        type: 'info',
        message: 'Creating buzz transaction',
        currency: updatedBenefactor.currency,
        amount: updatedBenefactor.unitAmount,
        isMultiTransaction: !!updatedBenefactor.buzzTransactionId,
      }).catch(() => null);

      switch (updatedBenefactor.currency) {
        case Currency.BUZZ: {
          if (
            updatedBenefactor.buzzTransactionId &&
            updatedBenefactor.buzzTransactionId.length > 0
          ) {
            // Collect all transactions from all transaction IDs (batch optimization)
            const allTransactions = [];
            let totalAmount = 0;

            // Process all transaction IDs in parallel for better performance
            const txResults = await Promise.allSettled(
              updatedBenefactor.buzzTransactionId.map(async (txId) => {
                const data = await getMultiAccountTransactionsByPrefix(txId);
                const txAmount = data.reduce((sum, t) => sum + t.amount, 0);

                logToAxiom({
                  ...logData,
                  name: 'bounty-award',
                  type: 'info',
                  message: 'Found multi-account transactions',
                  transactionId: txId,
                  transactionCount: data.length,
                  totalAmount: txAmount,
                }).catch(() => null);

                return { data, txAmount, txId };
              })
            );

            // Aggregate successful results
            for (const result of txResults) {
              if (result.status === 'fulfilled' && result.value) {
                const { data, txAmount } = result.value;
                totalAmount += txAmount;

                const transactions = data.map((t) => ({
                  fromAccountId: 0,
                  toAccountId: entry.userId as number,
                  toAccountType: t.accountType,
                  amount: t.amount,
                  type: TransactionType.Bounty,
                  description: 'Reason: Bounty entry has been awarded!',
                  details: {
                    entityId: entry.bountyId,
                    entityType: 'Bounty',
                  },
                  externalTransactionId: `bounty-award-${id}-${String(t.accountType)}`,
                }));

                allTransactions.push(...transactions);
              }
            }

            // Single batched call for all transactions (performance optimization)
            if (allTransactions.length > 0) {
              await createBuzzTransactionMany(allTransactions);
            }

            logToAxiom({
              ...logData,
              name: 'bounty-award',
              type: 'info',
              message: 'All multi-account buzz transactions created (batched)',
              transactionIdCount: updatedBenefactor.buzzTransactionId.length,
              totalTransactions: allTransactions.length,
              totalAmount,
            }).catch(() => null);

            // Log any failures
            txResults.forEach((result, index) => {
              if (result.status === 'rejected') {
                logToAxiom({
                  ...logData,
                  name: 'bounty-award',
                  type: 'error',
                  message: 'Transaction lookup failed',
                  txId: updatedBenefactor.buzzTransactionId[index],
                  error: result.reason,
                }).catch(() => null);
              }
            });
          } else {
            // Fallback: No transaction IDs recorded (legacy data)
            await createBuzzTransaction({
              fromAccountId: 0,
              toAccountId: entry.userId,
              amount: updatedBenefactor.unitAmount,
              type: TransactionType.Bounty,
              description: 'Reason: Bounty entry has been awarded!',
              details: {
                entityId: entry.bountyId,
                entityType: 'Bounty',
              },
            });
            await logToAxiom({
              ...logData,
              name: 'bounty-award',
              type: 'info',
              message: 'Single buzz transaction created (no recorded transaction IDs)',
              amount: updatedBenefactor.unitAmount,
            }).catch(() => null);
          }

          break;
        }
        default: // Do no checks
          break;
      }

      // 8. Check if all benefactors have awarded (use tx context for consistency)
      await logToAxiom({
        ...logData,
        name: 'bounty-award',
        type: 'info',
        message: 'Checking if all benefactors have awarded',
      }).catch(() => null);

      const unawardedBountyBenefactors = await tx.bountyBenefactor.findFirst({
        select: { userId: true },
        where: {
          awardedToId: null,
          bountyId: benefactor.bountyId,
        },
      });

      // 9. Mark bounty as complete only if ALL benefactors have awarded
      if (!unawardedBountyBenefactors) {
        await logToAxiom({
          ...logData,
          name: 'bounty-award',
          type: 'info',
          message: 'All benefactors have awarded - marking bounty complete',
        }).catch(() => null);

        await tx.bounty.update({
          where: { id: entry.bountyId },
          data: { complete: true },
        });

        await logToAxiom({
          ...logData,
          name: 'bounty-award',
          type: 'info',
          message: 'Bounty marked as complete',
        }).catch(() => null);
      } else {
        await logToAxiom({
          ...logData,
          name: 'bounty-award',
          type: 'info',
          message: 'Some benefactors have not yet awarded - bounty remains incomplete',
          unawardedBenefactorUserId: unawardedBountyBenefactors.userId,
        }).catch(() => null);
      }

      return updatedBenefactor;
    },
    { maxWait: 10000, timeout: 30000 }
  );

  await logToAxiom({
    ...logData,
    name: 'bounty-award',
    type: 'info',
    message: 'Award bounty entry completed successfully',
    awardedAmount: benefactor.unitAmount,
    currency: benefactor.currency,
  }).catch(() => null);

  return benefactor;
};

export const getBountyEntryFilteredFiles = async ({
  id,
  userId,
  isModerator,
}: {
  id: number;
  userId?: number;
  isModerator?: boolean;
}) => {
  const bountyEntry = await dbRead.bountyEntry.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      userId: true,
      bountyId: true,
    },
  });

  const files = await getFilesByEntity({ id: bountyEntry.id, type: 'BountyEntry' });

  if (bountyEntry.userId === userId || isModerator) {
    // Owner can see all files.
    return files.map((f) => ({
      ...f,
      metadata: f.metadata as BountyEntryFileMeta,
    }));
  }
  const benefactor = !userId
    ? null
    : await dbRead.bountyBenefactor.findUnique({
        where: {
          bountyId_userId: {
            userId,
            bountyId: bountyEntry.bountyId,
          },
        },
        select: {
          awardedToId: true,
          currency: true,
        },
      });

  const [awardedBounty] = await getBountyEntryEarnedBuzz({
    ids: [bountyEntry.id],
    currency: benefactor?.currency ?? Currency.BUZZ,
  });

  return files.map((f) => {
    const details = f.metadata as BountyEntryFileMeta;
    // TODO: Once we support Tipping entries - we need to check if a tipConnection is created
    let hasFullAccess = details.benefactorsOnly ? benefactor?.awardedToId === bountyEntry.id : true;

    if (awardedBounty.awardedUnitAmount < (details.unlockAmount ?? 0)) {
      hasFullAccess = false;
    }

    return {
      ...f,
      url: hasFullAccess ? f.url : null,
      metadata: f.metadata as BountyEntryFileMeta,
    };
  });
};

export const deleteBountyEntry = async ({
  id,
  isModerator,
}: {
  id: number;
  isModerator: boolean;
}) => {
  const entry = await dbRead.bountyEntry.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      bountyId: true,
      userId: true,
      bounty: {
        select: {
          complete: true,
        },
      },
    },
  });

  if (!entry) {
    throw throwBadRequestError('Bounty entry does not exist');
  }

  if (!isModerator) {
    const [award] = await getBountyEntryEarnedBuzz({ ids: [entry.id] });

    if (award.awardedUnitAmount > 0) {
      throw throwBadRequestError(
        'This bounty entry has been awarded by some users and as such, cannot be deleted.'
      );
    }
  }

  const deletedBountyEntry = await dbWrite.$transaction(
    async (tx) => {
      const deletedBountyEntry = await tx.bountyEntry.delete({ where: { id } });
      if (!deletedBountyEntry) return null;

      await tx.file.deleteMany({ where: { entityId: id, entityType: 'BountyEntry' } });
      const images = await tx.imageConnection.findMany({
        select: { imageId: true },
        where: { entityId: id, entityType: 'BountyEntry' },
      });

      await tx.imageConnection.deleteMany({ where: { entityId: id, entityType: 'BountyEntry' } });
      const imageIds = images.map((i) => i.imageId);
      await Promise.all([
        tx.image.deleteMany({ where: { id: { in: imageIds } } }),
        invalidateManyImageExistence(imageIds),
      ]);

      return deletedBountyEntry;
    },
    { maxWait: 10000, timeout: 30000 }
  );

  if (!deletedBountyEntry) return null;

  return deletedBountyEntry;
};
