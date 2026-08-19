import pLimit from 'p-limit';
import { isPaidAccessActive } from '@civitai/buzz';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { ModelVersionMeta } from '~/server/schema/model-version.schema';
import {
  getMultiAccountTransactionsByPrefix,
  getUserBuzzAccountByAccountTypes,
  refundMultiAccountTransaction,
} from '~/server/services/buzz.service';
import { paidAccessPayoutAccount } from '~/server/utils/buzz-helpers';
import { isWithinPaidAccessRefundWindow } from '~/server/utils/early-access-helpers';
import { throwBadRequestError, throwInsufficientFundsError } from '~/server/utils/errorHandling';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { BuzzTypes } from '~/shared/constants/buzz.constants';
import type { Prisma } from '@prisma/client';

/** The requirement as the unpublish dialogs read it — counts only, no buyer identities. */
export type EarlyAccessRefundSummary = {
  purchaseCount: number;
  buyerCount: number;
  totalBuzz: number;
  exemptBuyerCount: number;
};

export const toEarlyAccessRefundSummary = ({
  purchases,
  buyerCount,
  totalBuzz,
  exemptBuyerCount,
}: ModelEarlyAccessRefundRequirement): EarlyAccessRefundSummary => ({
  purchaseCount: purchases.length,
  buyerCount,
  totalBuzz,
  exemptBuyerCount,
});

export type ModelEarlyAccessRefundRequirement = {
  purchases: {
    modelVersionId: number;
    buyerId: number;
    buzzTransactionIds: string[];
  }[];
  buyerCount: number;
  totalBuzz: number;
  /** What reversing these purchases debits from each of the owner's accounts, keyed by account. */
  totalsByAccount: Partial<Record<BuzzSpendType, number>>;
  /**
   * Distinct buyers whose purchase is too old to refund. Carried so the unpublish dialog can say
   * what happens to them rather than going silent.
   */
  exemptBuyerCount: number;
};

// Early access is sold per model VERSION, so the refund set is computed version-by-version and each
// purchase keeps its modelVersionId. Unpublishing a whole model aggregates every version's set;
// unpublishing one version passes only that version — same obligation, narrower scope.
//
// Refundable = a buzz-purchased EntityAccess grant, bought within the refund window, on a version
// whose PaidAccess gate is still active (permanent, or a timed window that hasn't lapsed).
// Lapsed-window buyers already got what they paid for, so they don't block.
//
// The window is measured per PURCHASE, not per version: a permanent gate never expires, so anything
// keyed off the version would owe its buyers a refund forever. Gate/grant rows are read fresh from
// the primary (dbWrite), not the cache/replica — this guard protects buyers' money.
const getEarlyAccessRefundRequirementForVersions = async (
  versions: { id: number; meta: Prisma.JsonValue }[]
): Promise<ModelEarlyAccessRefundRequirement> => {
  const empty: ModelEarlyAccessRefundRequirement = {
    purchases: [],
    buyerCount: 0,
    totalBuzz: 0,
    totalsByAccount: {},
    exemptBuyerCount: 0,
  };
  const flagged = versions.filter(
    (v) => (v.meta as ModelVersionMeta | null)?.hadEarlyAccessPurchase
  );
  if (flagged.length === 0) return empty;

  const gates = await dbWrite.paidAccess.findMany({
    where: { entityType: 'ModelVersion', entityId: { in: flagged.map((v) => v.id) } },
    select: { entityId: true, endsAt: true },
  });
  const now = new Date();
  const activeGateVersionIds = gates
    .filter((gate) => isPaidAccessActive(gate, now))
    .map((gate) => gate.entityId);
  if (activeGateVersionIds.length === 0) return empty;

  const accessRows = await dbWrite.entityAccess.findMany({
    where: {
      accessToType: 'ModelVersion',
      accessToId: { in: activeGateVersionIds },
      accessorType: 'User',
    },
    select: { accessToId: true, accessorId: true, meta: true, addedAt: true },
  });

  // Only rows carrying a purchase transaction id count — owner-granted access has nothing to refund.
  const allPurchases = accessRows
    .map((row) => {
      const rowMeta = (row.meta ?? {}) as Record<string, unknown>;
      const buzzTransactionIds = ['download-buzzTransactionId', 'generation-buzzTransactionId']
        .map((key) => rowMeta[key])
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
      return {
        modelVersionId: row.accessToId,
        buyerId: row.accessorId,
        buzzTransactionIds,
        addedAt: row.addedAt,
      };
    })
    .filter((purchase) => purchase.buzzTransactionIds.length > 0);

  const refundable = allPurchases.filter((purchase) =>
    isWithinPaidAccessRefundWindow(purchase.addedAt, now)
  );
  const exemptBuyerCount = new Set(
    allPurchases
      .filter((purchase) => !isWithinPaidAccessRefundWindow(purchase.addedAt, now))
      .map((purchase) => purchase.buyerId)
  ).size;
  const purchases = refundable.map(({ addedAt: _addedAt, ...purchase }) => purchase);
  if (purchases.length === 0) return { ...empty, exemptBuyerCount };

  // Refund amounts come from the ledger, not current terms — prices can change after purchase.
  const limit = pLimit(5);
  const ledgers = await Promise.all(
    purchases
      .flatMap((purchase) => purchase.buzzTransactionIds)
      .map((prefix) => limit(() => getMultiAccountTransactionsByPrefix(prefix)))
  );

  // Each leg is reported by the account the BUYER spent from, so the owner's side has to be
  // re-derived through the same mapping the charge used.
  const totalsByAccount: Partial<Record<BuzzSpendType, number>> = {};
  for (const leg of ledgers.flat()) {
    const account = paidAccessPayoutAccount(BuzzTypes.toSpendType(leg.accountType));
    totalsByAccount[account] = (totalsByAccount[account] ?? 0) + leg.amount;
  }

  return {
    purchases,
    buyerCount: new Set(purchases.map((purchase) => purchase.buyerId)).size,
    totalBuzz: Object.values(totalsByAccount).reduce((sum, amount) => sum + amount, 0),
    totalsByAccount,
    exemptBuyerCount,
  };
};

export const getModelEarlyAccessRefundRequirement = async ({
  id,
}: GetByIdInput): Promise<ModelEarlyAccessRefundRequirement> =>
  getEarlyAccessRefundRequirementForVersions(
    await dbWrite.modelVersion.findMany({
      where: { modelId: id },
      select: { id: true, meta: true },
    })
  );

export const getModelVersionEarlyAccessRefundRequirement = async ({
  id,
}: GetByIdInput): Promise<ModelEarlyAccessRefundRequirement> =>
  getEarlyAccessRefundRequirementForVersions(
    await dbWrite.modelVersion.findMany({
      where: { id },
      select: { id: true, meta: true },
    })
  );

export const refundModelEarlyAccessPurchases = async ({
  modelId,
  requirement,
  // Reaches the buyer in their Buzz history, so it has to say which of the two take-downs refunded
  // them — the model, or one version of it.
  scope = 'model',
}: {
  modelId: number;
  requirement: ModelEarlyAccessRefundRequirement;
  scope?: 'model' | 'version';
}) => {
  const model = await dbWrite.model.findUniqueOrThrow({
    where: { id: modelId },
    select: { name: true, userId: true },
  });

  // Checked per account, not against one total: a creator paid in blue holds nothing in yellow, and
  // the two are not interchangeable. The ledger exempts refunds from its own sufficiency check and
  // will take an account negative, so nothing downstream re-checks this.
  const accounts = Object.keys(requirement.totalsByAccount) as BuzzSpendType[];
  const balances = await getUserBuzzAccountByAccountTypes(model.userId, accounts);
  const shortfalls = accounts
    .map((account) => ({
      account,
      required: requirement.totalsByAccount[account] ?? 0,
      available: balances[account] ?? 0,
    }))
    .filter(({ required, available }) => available < required);

  if (shortfalls.length > 0) {
    throw throwInsufficientFundsError(
      `Refunding early access buyers requires ${shortfalls
        .map((s) => `${s.required} ${s.account} Buzz but the account only has ${s.available}`)
        .join('; ')}.`
    );
  }

  let refundedCount = 0;
  for (const purchase of requirement.purchases) {
    try {
      for (const prefix of purchase.buzzTransactionIds) {
        await refundMultiAccountTransaction({
          externalTransactionIdPrefix: prefix,
          description: `Refund early access purchase: ${model.name} (${scope} unpublished)`,
        });
      }
      // Revoke the now-refunded grant so a retry after a mid-loop failure skips this buyer
      // instead of refunding them twice. deleteMany, not delete: the money already moved, so an
      // already-gone row must not abort the loop.
      await dbWrite.entityAccess.deleteMany({
        where: {
          accessToId: purchase.modelVersionId,
          accessToType: 'ModelVersion',
          accessorId: purchase.buyerId,
          accessorType: 'User',
        },
      });
      refundedCount++;
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: `${scope}-unpublish-early-access-refund`,
        message: `Failed to refund early access purchases for ${scope} ${
          scope === 'version' ? purchase.modelVersionId : modelId
        }`,
        error,
        scope,
        modelId,
        modelVersionId: purchase.modelVersionId,
        buyerId: purchase.buyerId,
        refundedCount,
      });
      throw throwBadRequestError(
        `Failed to refund early access buyers (${refundedCount} of ${requirement.purchases.length} refunded). The ${scope} was not unpublished — please try again.`
      );
    }
  }
};
