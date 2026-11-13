import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { Prisma } from '@prisma/client';
import type {
  CosmeticPurchaseMeta,
  CosmeticShopItemHistoryEntry,
  CosmeticShopItemMeta,
} from '~/server/schema/cosmetic-shop.schema';
import {
  getMultiAccountTransactionsByPrefix,
  getTransactionByExternalId,
} from '~/server/services/buzz.service';
import { refundTransactionOnce } from '~/server/services/buzz-prefix-refund';
import { revokeCosmeticsFromUsers } from '~/server/services/cosmetic.service';
import { CREATOR_SHOP_HISTORY_LIMIT } from '~/server/services/creator-shop.data';
import { createNotification } from '~/server/services/notification.service';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { withRetries } from '~/server/utils/errorHandling';

/**
 * Refunds the buyers of a Creator Shop item that was withdrawn after it sold (rejected by a
 * moderator, or archived while withheld), and the purchases a moderator names through
 * `refundShopPurchases`. A verdict or archive always reverses the creator's payouts; a manual
 * refund only when `clawback`. The trigger is `meta.withdrawnRefund`; this reads it, so the
 * immediate call and the retry job do the same thing.
 *
 * Each reversal is the Buzz service's own refund of one transaction, recorded as
 * `refund-<transactionId>`, so a transaction is refunded at most once however often this runs.
 * A purchase is marked `refunded` only once every reversal it needs has landed, and the buyer
 * loses the cosmetic only then.
 */

const DESCRIPTIONS = {
  reject: 'Refund: Creator Shop item withdrawn',
  archive: 'Refund: Creator Shop item withdrawn',
  manual: 'Refund: Creator Shop purchase',
} as const;
const MONEY_RETRIES = 3;
const MONEY_RETRY_DELAY_MS = 1000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LedgerRow = {
  transactionId: string;
  externalTransactionId?: string | null;
  accountId: number;
  amount: number;
};

/**
 * A purchase's ledger rows: the buyer's debit per colour (`<P>-<accountType>`) and each payout
 * (`<P>:sell:<userId>:<colour>`). Sales before payouts were recorded under the prefix stored the
 * buyer charge's own id, so they have no debit under it, and paid from the bank keyed by that id,
 * or by it and the recipient (`<P>:<userId>`) when the pool was split. Anything else is `other`,
 * and stops the purchase: only these shapes are reversed.
 */
export function classifyPurchaseLedger(
  purchase: { buzzTransactionId: string; userId: number; unitAmount: number },
  rows: LedgerRow[]
) {
  const P = purchase.buzzTransactionId;
  const debits: LedgerRow[] = [];
  const payouts: LedgerRow[] = [];
  const other: LedgerRow[] = [];
  for (const row of rows) {
    const ext = row.externalTransactionId ?? '';
    if (ext.startsWith(`${P}:sell:`)) payouts.push(row);
    else if (ext.startsWith(`${P}-`) && row.accountId === purchase.userId) debits.push(row);
    else if (row.accountId === 0 && GUID.test(P) && (ext === P || ext.startsWith(`${P}:`)))
      payouts.push(row);
    else other.push(row);
  }
  if (!debits.length && GUID.test(P))
    debits.push({ transactionId: P, accountId: purchase.userId, amount: purchase.unitAmount });
  return { debits, payouts, other };
}

/** Who a payout paid, where its key names them; one keyed by the purchase id alone names no one. */
function payoutRecipient(purchaseId: string, payout: LedgerRow) {
  const match = (payout.externalTransactionId ?? '')
    .slice(purchaseId.length)
    .match(/^:(?:sell:)?(\d+)(?::|$)/);
  return match ? Number(match[1]) : undefined;
}

type PayoutFailure = {
  transactionId: string;
  recipientId?: number;
  amount: number;
  error: string;
};
type PurchaseOutcome =
  | {
      status: 'refunded';
      refunded: number;
      clawedBack: number;
      payoutFailures: PayoutFailure[];
    }
  /** `refunded`: what of the buyer's debits is already back, so a hand refund pays only the rest. */
  | { status: 'failed'; error: string; refunded?: number };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Refunds one transaction unless its `refund-<id>` is already on the ledger. */
async function refundOnce(transactionId: string, description: string) {
  if (await getTransactionByExternalId(`refund-${transactionId}`)) return;
  await withRetries(
    () => refundTransactionOnce(transactionId, description),
    MONEY_RETRIES,
    MONEY_RETRY_DELAY_MS
  );
}

/** The purchase's debits and payouts, or why they can't be reversed. The dry run reads this too. */
async function readPurchaseLedger(purchase: {
  buzzTransactionId: string;
  userId: number;
  unitAmount: number;
}): Promise<
  { error: string } | { error?: undefined; debits: LedgerRow[]; payouts: LedgerRow[]; paid: number }
> {
  let rows: LedgerRow[];
  try {
    rows = await getMultiAccountTransactionsByPrefix(purchase.buzzTransactionId);
  } catch (error) {
    return { error: messageOf(error) };
  }
  const { debits, payouts, other } = classifyPurchaseLedger(purchase, rows);
  if (other.length) return { error: `unexpected transactions under the purchase: ${other.length}` };
  const paid = debits.reduce((sum, t) => sum + t.amount, 0);
  if (paid !== purchase.unitAmount)
    return { error: `debits ${paid} do not match the price ${purchase.unitAmount}` };
  return { debits, payouts, paid };
}

/**
 * Reverses one purchase from its ledger. Every leg is refunded by its own transaction id, at most
 * once, so a run that dies partway is finished by running it again. A takedown passes its own
 * `description`.
 */
export async function reversePurchase(
  purchase: { buzzTransactionId: string; userId: number; unitAmount: number },
  {
    clawback,
    trigger,
    description = DESCRIPTIONS[trigger],
  }: Pick<RefundTerms, 'clawback' | 'trigger'> & { description?: string }
): Promise<PurchaseOutcome> {
  const ledger = await readPurchaseLedger(purchase);
  if (ledger.error !== undefined) return { status: 'failed', error: ledger.error };
  const { debits, payouts, paid } = ledger;

  // Payouts first, and nothing is refunded until they are all back: the creator pays on archive.
  if (clawback && trigger === 'archive') {
    for (const t of [...payouts, ...debits]) {
      try {
        await refundOnce(t.transactionId, description);
      } catch (error) {
        return { status: 'failed', error: messageOf(error) };
      }
    }
    const clawedBack = payouts.reduce((sum, t) => sum + t.amount, 0);
    return { status: 'refunded', refunded: paid, clawedBack, payoutFailures: [] };
  }

  // The buyer first: until every debit is back the purchase stays owed and the job retries it.
  let refunded = 0;
  for (const t of debits) {
    try {
      await refundOnce(t.transactionId, description);
      refunded += t.amount;
    } catch (error) {
      return { status: 'failed', error: messageOf(error), refunded };
    }
  }
  // A payout that won't come back does not hold the buyer's refund: it is logged for a person to
  // finish, as a takedown does.
  let clawedBack = 0;
  const payoutFailures: PayoutFailure[] = [];
  for (const t of clawback ? payouts : []) {
    try {
      await refundOnce(t.transactionId, description);
      clawedBack += t.amount;
    } catch (error) {
      payoutFailures.push({
        transactionId: t.transactionId,
        recipientId: payoutRecipient(purchase.buzzTransactionId, t),
        amount: t.amount,
        error: messageOf(error),
      });
    }
  }
  return { status: 'refunded', refunded: paid, clawedBack, payoutFailures };
}

async function markerStands(shopItemId: number, at: string) {
  const current = await dbWrite.cosmeticShopItem.findUnique({
    where: { id: shopItemId },
    select: { meta: true },
  });
  const meta = (current?.meta ?? {}) as CosmeticShopItemMeta;
  // A takedown landing mid-run owns every purchase not yet begun here.
  return !meta.takedown && meta.withdrawnRefund?.at === at;
}

const logRefund = (
  level: 'info' | 'error',
  message: string,
  data: Record<string, unknown>,
  name = 'creator-shop-withdrawn-refund'
) => logToAxiom({ level, name, message, data }).catch(() => undefined);

type RefundTerms = NonNullable<CosmeticPurchaseMeta['withdrawnRefund']>;
type OwedPurchase = {
  userId: number;
  buzzTransactionId: string;
  unitAmount: number;
  meta: Prisma.JsonValue;
};

/** Records the terms on the purchase before any of its money moves, so a retry finishes on them. */
async function stampTerms(purchase: OwedPurchase, terms: RefundTerms) {
  await dbWrite.userCosmeticShopPurchases.update({
    where: { buzzTransactionId: purchase.buzzTransactionId },
    data: {
      meta: {
        ...((purchase.meta ?? {}) as CosmeticPurchaseMeta),
        withdrawnRefund: terms,
      } as Prisma.InputJsonValue,
    },
  });
}

/**
 * Reverses one stamped purchase, takes the cosmetic back and marks it refunded. `marked` is false
 * when another run marked it first; that run counts it.
 */
async function settlePurchase(
  purchase: OwedPurchase,
  terms: RefundTerms,
  cosmeticId: number
): Promise<
  | { status: 'failed'; error: string }
  | {
      status: 'refunded';
      marked: boolean;
      refunded: number;
      clawedBack: number;
      payoutFailures: PayoutFailure[];
      revoked: number;
    }
> {
  const outcome: PurchaseOutcome =
    purchase.unitAmount === 0
      ? { status: 'refunded', refunded: 0, clawedBack: 0, payoutFailures: [] }
      : await reversePurchase(purchase, terms);
  if (outcome.status === 'failed') return outcome;
  // Taken back before the purchase is marked, so a run that dies in between is retried and a
  // refunded buyer never keeps it. Scoped to this purchase: a holding obtained any other way was
  // not paid for here.
  const { revoked } = await revokeCosmeticsFromUsers({
    userIds: [purchase.userId],
    cosmeticIds: [cosmeticId],
    claimKeys: [purchase.buzzTransactionId],
  });
  const { count } = await dbWrite.userCosmeticShopPurchases.updateMany({
    where: { buzzTransactionId: purchase.buzzTransactionId, refunded: false },
    data: { refunded: true },
  });
  return { ...outcome, marked: count > 0, revoked };
}

async function appendHistoryInPlace(shopItemId: number, entry: CosmeticShopItemHistoryEntry) {
  // One statement touching only `history`: writing back the whole meta read earlier would undo a
  // verdict that landed during the run, marker included.
  await dbWrite.$executeRaw`
    UPDATE "CosmeticShopItem"
    SET meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{history}', (
      SELECT coalesce(jsonb_agg(kept.e ORDER BY kept.o), '[]'::jsonb)
      FROM (
        SELECT x.e, x.o
        FROM jsonb_array_elements(
          coalesce(meta->'history', '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb
        ) WITH ORDINALITY AS x(e, o)
        ORDER BY x.o DESC
        LIMIT ${CREATOR_SHOP_HISTORY_LIMIT}
      ) kept
    ))
    WHERE id = ${shopItemId}
  `;
}

/**
 * Runs the refund for one item. Serialised per item, so two verdicts landing together, or a
 * verdict and the job, refund once. Returns null when another run holds the item; the job picks
 * up whatever that run leaves. `limit` caps the purchases one run takes, oldest first, so a
 * request does not wait on an item with hundreds of sales.
 */
export async function refundWithdrawnShopItem(
  shopItemId: number,
  { limit }: { limit?: number } = {}
) {
  return withShopItemRefundLock(shopItemId, () => runWithdrawnRefund(shopItemId, limit));
}

/**
 * The one lock every run that refunds an item's purchases holds: the withdrawn refund, a
 * moderator's refund and a takedown. Null when it is held elsewhere; `queue` keeps trying for about
 * thirty seconds, for a caller that cannot leave the work to the job.
 */
export function withShopItemRefundLock<T>(
  shopItemId: number,
  operation: () => Promise<T>,
  { queue = false }: { queue?: boolean } = {}
) {
  return withDistributedLock(
    {
      key: `creator-shop-withdrawn-refund:${shopItemId}`,
      ttl: 60,
      autoRenew: true,
      ...(queue ? { retryDelay: 500, maxRetries: 60 } : { maxRetries: 0 }),
    },
    operation
  );
}

const loadItem = (shopItemId: number) =>
  dbWrite.cosmeticShopItem.findUnique({
    where: { id: shopItemId },
    select: {
      id: true,
      title: true,
      cosmeticId: true,
      addedById: true,
      meta: true,
      cosmetic: { select: { createdById: true } },
    },
  });
type RefundableItem = NonNullable<Awaited<ReturnType<typeof loadItem>>>;

// A creator buying their own item paid the platform; it is not a sale to refund.
const creatorOf = (item: RefundableItem) => item.cosmetic?.createdById ?? item.addedById;

async function runWithdrawnRefund(shopItemId: number, limit?: number) {
  const item = await loadItem(shopItemId);
  const meta = (item?.meta ?? {}) as CosmeticShopItemMeta;
  const marker = meta.withdrawnRefund;
  // A pack's members are listed, and withheld, on their own, so withdrawing the pack withholds
  // nothing its buyers hold.
  if (!item || item.cosmeticId == null) return { purchases: 0, refunded: 0, failures: 0 };
  // A takedown refunds and claws back on its own terms, except purchases already begun here.
  const owedByMarker = meta.takedown ? undefined : marker;

  const creatorId = creatorOf(item);
  const unrefunded = await dbWrite.userCosmeticShopPurchases.findMany({
    where: {
      shopItemId,
      refunded: false,
      ...(creatorId ? { userId: { not: creatorId } } : {}),
    },
    select: {
      userId: true,
      buzzTransactionId: true,
      unitAmount: true,
      purchasedAt: true,
      meta: true,
    },
    orderBy: { purchasedAt: 'asc' },
  });
  // A purchase whose reversal has started carries the terms it started under, and is finished on
  // them even after the item's marker is cleared: stopping halfway would leave some of its legs
  // reversed and the rest not. Any other purchase is owed only while the marker stands.
  const purchases = unrefunded
    .flatMap((purchase) => {
      const started = (purchase.meta as CosmeticPurchaseMeta | null)?.withdrawnRefund;
      const terms = started
        ? // Taken down since it began: finished as a takedown would, buyer first and the
          // payouts reversed whatever the archive had said.
          meta.takedown
          ? { ...started, trigger: 'reject' as const, clawback: true }
          : started
        : owedByMarker && purchase.purchasedAt <= new Date(owedByMarker.at)
        ? owedByMarker
        : undefined;
      return terms ? [{ purchase, terms, started: !!started }] : [];
    })
    .slice(0, limit);

  const refunded: (typeof purchases)[number]['purchase'][] = [];
  const failures: { buzzTransactionId: string; userId: number; error: string }[] = [];
  const payoutFailures: (PayoutFailure & { buzzTransactionId: string })[] = [];
  let refundedValue = 0;
  let clawedBack = 0;
  let revoked = 0;
  let stopped = false;
  for (const { purchase, terms, started } of purchases) {
    if (!started) {
      // An approval or a restore clears the marker; one landing mid-run stops every purchase not
      // yet begun.
      if (stopped || !(await markerStands(shopItemId, terms.at))) {
        stopped = true;
        continue;
      }
      await stampTerms(purchase, terms);
    }
    const outcome = await settlePurchase(purchase, terms, item.cosmeticId);
    if (outcome.status === 'failed') {
      failures.push({ ...purchase, error: outcome.error });
      await logRefund('error', 'Purchase refund failed', { shopItemId, ...purchase, ...outcome });
      continue;
    }
    for (const failure of outcome.payoutFailures) {
      payoutFailures.push({ ...failure, buzzTransactionId: purchase.buzzTransactionId });
      await logRefund('error', 'Payout clawback failed', { shopItemId, ...purchase, ...failure });
    }
    revoked += outcome.revoked;
    if (!outcome.marked) continue;
    refunded.push(purchase);
    refundedValue += outcome.refunded;
    clawedBack += outcome.clawedBack;
  }

  if (refunded.length) {
    for (const userId of new Set(refunded.map((p) => p.userId)))
      await createNotification({
        type: 'cosmetic-shop-item-refunded',
        userId,
        category: NotificationCategory.System,
        key: `cosmetic-shop-item-refunded:${shopItemId}:${userId}`,
        details: { title: item.title },
      }).catch(() => undefined);

    await appendHistoryInPlace(shopItemId, {
      at: new Date().toISOString(),
      userId: (marker ?? purchases[0].terms).userId,
      kind: 'refunded',
      note: `${refunded.length} purchase(s), ${refundedValue} Buzz refunded; ${clawedBack} Buzz reversed from payouts`,
    });
  }

  const summary = {
    shopItemId,
    marker: marker ?? null,
    purchases: purchases.length,
    refunded: refunded.length,
    refundedValue,
    clawedBack,
    revokedFrom: revoked,
    failures,
    payoutFailures,
    stoppedByVerdict: stopped,
  };
  if (purchases.length)
    await logRefund(
      failures.length || payoutFailures.length ? 'error' : 'info',
      'Withdrawn refund finished',
      summary
    );
  return { purchases: purchases.length, refunded: refunded.length, failures: failures.length };
}

/**
 * Retry for every item whose refund did not finish: a Buzz failure, a lock held elsewhere, or a
 * process that died mid-run. Due means the same purchases `runWithdrawnRefund` would select.
 */
export async function sweepWithdrawnShopRefunds({ limit = 50 }: { limit?: number } = {}) {
  const due = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT i.id
    FROM "CosmeticShopItem" i
    LEFT JOIN "Cosmetic" c ON c.id = i."cosmeticId"
    WHERE i."cosmeticId" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "UserCosmeticShopPurchases" p
        WHERE p."shopItemId" = i.id
          AND NOT p.refunded
          AND p."userId" IS DISTINCT FROM COALESCE(c."createdById", i."addedById")
          AND (
            -- Started under an earlier marker: finished whatever the item says now, takedown
            -- included.
            coalesce(p.meta ? 'withdrawnRefund', false)
            OR (
              NOT coalesce(i.meta ? 'takedown', false)
              AND i.meta ? 'withdrawnRefund'
              AND p."purchasedAt" <=
                ((i.meta->'withdrawnRefund'->>'at')::timestamptz AT TIME ZONE 'UTC')
            )
          )
      )
    -- Newest first: an item whose purchases can never be reversed is logged on every run and
    -- must not hold the window against items still being worked through.
    ORDER BY (i.meta->'withdrawnRefund'->>'at') DESC NULLS LAST
    LIMIT ${limit}
  `;

  let refunded = 0;
  let failures = 0;
  let busy = 0;
  for (const { id } of due) {
    const result = await refundWithdrawnShopItem(id);
    if (!result) busy++;
    else {
      refunded += result.refunded;
      failures += result.failures;
    }
  }
  return { items: due.length, refunded, failures, busy };
}

type LegPlan = {
  kind: 'debit' | 'payout';
  transactionId: string;
  accountId: number;
  amount: number;
  alreadyRefunded: boolean;
};
type PurchaseRefundResult = {
  buzzTransactionId: string;
  userId?: number;
  shopItemId?: number;
  status: 'planned' | 'refunded' | 'skipped-already-refunded' | 'failed';
  error?: string;
  legs?: LegPlan[];
  refunded?: number;
  clawedBack?: number;
  payoutFailures?: PayoutFailure[];
};
type RefundablePurchase = OwedPurchase & { shopItemId: number; refunded: boolean };

const PURCHASE_REFUND_LOG = 'creator-shop-purchase-refund';
const TAKEN_DOWN = 'the item was taken down; the takedown refunds its purchases';

const takenDown = async (shopItemId: number) =>
  !!((await loadItem(shopItemId))?.meta as CosmeticShopItemMeta | null)?.takedown;

const loadPurchases = (ids: string[]) =>
  dbWrite.userCosmeticShopPurchases.findMany({
    where: { buzzTransactionId: { in: ids } },
    select: {
      userId: true,
      shopItemId: true,
      buzzTransactionId: true,
      unitAmount: true,
      refunded: true,
      meta: true,
    },
  });

function refusal(purchase: RefundablePurchase, item: RefundableItem | null, clawback: boolean) {
  if (!item) return 'shop item not found';
  // A pack's members are granted on their own, so there is no single holding to take back.
  if (item.cosmeticId == null) return 'packs are not supported';
  if ((item.meta as CosmeticShopItemMeta | null)?.takedown) return TAKEN_DOWN;
  if (purchase.userId === creatorOf(item)) return "the creator's own purchase is not a sale";
  const started = (purchase.meta as CosmeticPurchaseMeta | null)?.withdrawnRefund;
  if (started && started.clawback !== clawback)
    return `a refund already began with clawback ${started.clawback}`;
  return null;
}

/** The legs a real run would reverse, read the way it reads them. */
async function planLegs(
  purchase: RefundablePurchase,
  clawback: boolean
): Promise<{ error: string } | { error?: undefined; legs: LegPlan[] }> {
  if (purchase.unitAmount === 0) return { legs: [] };
  const ledger = await readPurchaseLedger(purchase);
  if (ledger.error !== undefined) return ledger;
  const legs = [
    ...ledger.debits.map((t) => ({ kind: 'debit' as const, ...t })),
    ...(clawback ? ledger.payouts.map((t) => ({ kind: 'payout' as const, ...t })) : []),
  ];
  return {
    legs: await Promise.all(
      legs.map(async ({ kind, transactionId, accountId, amount }) => ({
        kind,
        transactionId,
        accountId,
        amount,
        alreadyRefunded: !!(await getTransactionByExternalId(`refund-${transactionId}`)),
      }))
    ),
  };
}

/**
 * A moderator's refund of named purchases, on the withdrawn-item path. Terms are stamped first, so
 * the withdrawn-refund job finishes a purchase a run leaves part done (unless a takedown lands
 * first, which finishes it as a takedown) and a second call refunds nothing twice. `dryRun` moves
 * nothing.
 */
export async function refundShopPurchases({
  buzzTransactionIds,
  clawback,
  reason,
  dryRun,
  moderatorId,
}: {
  buzzTransactionIds: string[];
  clawback: boolean;
  reason: string;
  dryRun: boolean;
  moderatorId: number;
}) {
  const ids = [...new Set(buzzTransactionIds)];
  const results = new Map<string, PurchaseRefundResult>(
    ids.map((id) => [id, { buzzTransactionId: id, status: 'failed', error: 'purchase not found' }])
  );
  const list = () => ids.map((id) => results.get(id)!);

  try {
    const found = await loadPurchases(ids);
    for (const shopItemId of new Set(found.map((p) => p.shopItemId))) {
      const owned = found.filter((p) => p.shopItemId === shopItemId);
      if (dryRun) {
        await planItem(shopItemId, owned, clawback, results);
        continue;
      }
      const ran = await withShopItemRefundLock(shopItemId, () =>
        refundItemPurchases(
          shopItemId,
          owned.map((p) => p.buzzTransactionId),
          { clawback, moderatorId },
          results
        )
      );
      if (ran === null)
        for (const p of owned)
          results.set(p.buzzTransactionId, {
            buzzTransactionId: p.buzzTransactionId,
            userId: p.userId,
            shopItemId,
            status: 'failed',
            error: 'another refund of this item is running; try again',
          });
    }
  } finally {
    // Written even when the call throws: it is the only record of what earlier purchases moved.
    if (!dryRun) {
      const outcome = list();
      await logRefund(
        outcome.some((r) => r.status === 'failed' || r.payoutFailures?.length) ? 'error' : 'info',
        'Purchase refund finished',
        { moderatorId, reason, clawback, buzzTransactionIds: ids, results: outcome },
        PURCHASE_REFUND_LOG
      );
    }
  }

  const outcome = list();
  const totals = {
    planned: outcome.filter((r) => r.status === 'planned').length,
    refunded: outcome.filter((r) => r.status === 'refunded').length,
    skipped: outcome.filter((r) => r.status === 'skipped-already-refunded').length,
    failed: outcome.filter((r) => r.status === 'failed').length,
    refundedValue: outcome.reduce((sum, r) => sum + (r.refunded ?? 0), 0),
    clawedBack: outcome.reduce((sum, r) => sum + (r.clawedBack ?? 0), 0),
  };
  return { dryRun, totals, results: outcome };
}

async function planItem(
  shopItemId: number,
  purchases: RefundablePurchase[],
  clawback: boolean,
  results: Map<string, PurchaseRefundResult>
) {
  const item = await loadItem(shopItemId);
  for (const purchase of purchases) {
    const id = purchase.buzzTransactionId;
    const base = { buzzTransactionId: id, userId: purchase.userId, shopItemId };
    if (purchase.refunded) {
      results.set(id, { ...base, status: 'skipped-already-refunded' });
      continue;
    }
    const refused = refusal(purchase, item, clawback);
    const plan = refused ? { error: refused } : await planLegs(purchase, clawback);
    results.set(
      id,
      plan.error !== undefined
        ? { ...base, status: 'failed', error: plan.error }
        : { ...base, status: 'planned', legs: plan.legs }
    );
  }
}

async function refundItemPurchases(
  shopItemId: number,
  ids: string[],
  { clawback, moderatorId }: { clawback: boolean; moderatorId: number },
  results: Map<string, PurchaseRefundResult>
) {
  // Read again under the lock: a run that held it may have refunded some of these.
  const purchases = await loadPurchases(ids);
  const terms: RefundTerms = {
    trigger: 'manual',
    clawback,
    userId: moderatorId,
    at: new Date().toISOString(),
  };
  const refunded: RefundablePurchase[] = [];
  let title: string | undefined;
  let refundedValue = 0;
  let clawedBack = 0;
  for (const purchase of purchases) {
    const id = purchase.buzzTransactionId;
    const base = { buzzTransactionId: id, userId: purchase.userId, shopItemId };
    if (purchase.refunded) {
      results.set(id, { ...base, status: 'skipped-already-refunded' });
      continue;
    }
    try {
      // A takedown archives and refunds under this lock, so it cannot land during this call. The
      // item is still read per purchase, and checked around the stamp below, in case the lock is
      // lost (a renewal that fails): a takedown owns every purchase not yet stamped.
      const item = await loadItem(shopItemId);
      const refused = refusal(purchase, item, clawback);
      if (refused || item?.cosmeticId == null) {
        results.set(id, { ...base, status: 'failed', error: refused ?? 'shop item not found' });
        continue;
      }
      title = item.title;
      // A purchase already begun is finished on the terms it began under.
      const started = (purchase.meta as CosmeticPurchaseMeta | null)?.withdrawnRefund;
      if (!started) {
        // Refused before the stamp: the job retries a stamped purchase, and nothing owes this one
        // but this call, so a ledger it cannot reverse would be retried and logged on every pass.
        if (purchase.unitAmount !== 0) {
          const ledger = await readPurchaseLedger(purchase);
          if (ledger.error !== undefined) {
            results.set(id, { ...base, status: 'failed', error: ledger.error });
            continue;
          }
        }
        if (await takenDown(shopItemId)) {
          results.set(id, { ...base, status: 'failed', error: TAKEN_DOWN });
          continue;
        }
        await stampTerms(purchase, terms);
      }
      // A takedown that lands after the stamp leaves the purchase here: finish it as the job would.
      const finishOn: RefundTerms = (await takenDown(shopItemId))
        ? { ...(started ?? terms), trigger: 'reject', clawback: true }
        : started ?? terms;
      const outcome = await settlePurchase(purchase, finishOn, item.cosmeticId);
      if (outcome.status === 'failed') {
        results.set(id, { ...base, status: 'failed', error: outcome.error });
        continue;
      }
      // Logged now: once the purchase is marked, a later failure in this call leaves no other
      // record of a payout that did not come back.
      for (const failure of outcome.payoutFailures)
        await logRefund(
          'error',
          'Payout clawback failed',
          { ...base, ...failure },
          PURCHASE_REFUND_LOG
        );
      if (!outcome.marked) {
        results.set(id, { ...base, status: 'skipped-already-refunded' });
        continue;
      }
      results.set(id, {
        ...base,
        status: 'refunded',
        refunded: outcome.refunded,
        clawedBack: outcome.clawedBack,
        payoutFailures: outcome.payoutFailures,
      });
      refunded.push(purchase);
      refundedValue += outcome.refunded;
      clawedBack += outcome.clawedBack;
    } catch (error) {
      results.set(id, { ...base, status: 'failed', error: messageOf(error) });
    }
  }
  if (!refunded.length) return;

  for (const userId of new Set(refunded.map((p) => p.userId)))
    await createNotification({
      type: 'cosmetic-shop-purchase-refunded',
      userId,
      category: NotificationCategory.System,
      key: `cosmetic-shop-purchase-refunded:${shopItemId}:${userId}:${terms.at}`,
      details: { title },
    }).catch(() => undefined);
  // The reason stays in Axiom: item history reaches the creator, and a reason can describe a buyer.
  await appendHistoryInPlace(shopItemId, {
    at: terms.at,
    userId: moderatorId,
    kind: 'refunded',
    note: `${refunded.length} purchase(s) refunded by a moderator, ${refundedValue} Buzz refunded; ${clawedBack} Buzz reversed from payouts`,
  }).catch(() => undefined);
}
