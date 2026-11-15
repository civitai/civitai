import { dbRead } from '~/server/db/client';
import {
  BLOCK_AUTHOR_FEE_ESTIMATE_LABEL,
  chargeBlockAuthorFee,
  quoteBlockAuthorFee,
} from '~/server/services/blocks/author-fee-charge.service';

/**
 * The author share on an output UNLOCK (`block-output-unlock.service`).
 *
 * Operator decision: the unlock carries the app's normal author share, applied the same way as
 * on the original spend. So it is priced from the ORIGINAL generation's accrual row (its base and
 * generation type), through the same quote and charge as a submit, and paid in Yellow, the
 * currency the unlock drains. A generation whose spend accrued no fee (the pass-through step
 * paths, a private run, self-dealing, the fee flag off when it ran) has none on its unlock either.
 *
 * It is a SEPARATE charge with its own idempotency anchor ({@link unlockAuthorFeeAnchor}): its own
 * debit key and its own accrual row, so it can neither collide with the original fee nor be
 * taken twice for one workflow.
 */

/**
 * ⚠️ OPEN PRODUCT QUESTION, one switch. On a path that charged a fee, the original fee was paid
 * from the pool the generation drained (Blue, for a 'pool' restriction). The orchestrator refunds
 * the generation's Blue cost on unlock, but not the host's Blue fee. `'on-top'` (current) charges
 * the Yellow unlock fee as well, itemised in the dialog. `'none-if-accrued'` would charge no fee
 * on an unlock whose original spend already accrued one.
 */
export type UnlockAuthorFeePolicy = 'on-top' | 'none-if-accrued';
export const UNLOCK_AUTHOR_FEE_POLICY: UnlockAuthorFeePolicy = 'on-top';

/** The original generation's fee, read from its accrual row. */
export type OriginalAuthorFee = {
  feeBuzz: number;
  baseGenerationBuzz: number;
  generationType: string | null;
};

/** Whether an unlock carries an author share, given the original spend's fee. The ONE switch. */
export function unlockAuthorFeeApplies(
  original: OriginalAuthorFee | null,
  policy: UnlockAuthorFeePolicy = UNLOCK_AUTHOR_FEE_POLICY
): original is OriginalAuthorFee {
  if (!original || !(original.feeBuzz > 0)) return false;
  return policy === 'on-top';
}

/** The unlock fee's own anchor: its debit key and its accrual row's `workflow_id`. */
export function unlockAuthorFeeAnchor(workflowId: string): string {
  return `unlock:${workflowId}`;
}

/** The original spend's accrued fee, or `null` when it accrued none. */
export async function readOriginalAuthorFee(workflowId: string): Promise<OriginalAuthorFee | null> {
  const row = await dbRead.blockAuthorFeeAccrual.findUnique({
    where: { workflowId },
    select: { feeBuzz: true, baseGenerationBuzz: true, generationType: true },
  });
  return row ?? null;
}

type UnlockFeeContext = {
  workflowId: string;
  original: OriginalAuthorFee | null;
  appId: string;
  viewerUserId: number;
  privateRun: boolean;
};

/**
 * The unlock's author share in Buzz (0 for none). `disclosure`: the host's preview, which is
 * shown and discarded (counted and logged as an estimate, as every estimate site is).
 */
export async function quoteUnlockAuthorFee(
  ctx: UnlockFeeContext & { disclosure: boolean }
): Promise<number> {
  if (!unlockAuthorFeeApplies(ctx.original)) return 0;
  const quote = await quoteBlockAuthorFee({
    baseGenerationBuzz: ctx.original.baseGenerationBuzz,
    priceIsCap: false,
    generationType: ctx.original.generationType,
    appId: ctx.appId,
    viewerUserId: ctx.viewerUserId,
    workflowLabel: ctx.disclosure
      ? BLOCK_AUTHOR_FEE_ESTIMATE_LABEL
      : unlockAuthorFeeAnchor(ctx.workflowId),
    suppressQuoteLogs: ctx.disclosure,
    privateRun: ctx.privateRun,
  });
  return quote.charge ? quote.feeBuzz : 0;
}

/**
 * Debit the unlock's author share in Yellow, clamped to `reservedAuthorFeeBuzz` (what the viewer
 * confirmed and the daily limit reserved). Returns the Buzz charged; never throws
 * (`chargeBlockAuthorFee` is total).
 */
export async function chargeUnlockAuthorFee(
  ctx: UnlockFeeContext & { appBlockId: string; reservedAuthorFeeBuzz: number }
): Promise<number> {
  if (!unlockAuthorFeeApplies(ctx.original)) return 0;
  const result = await chargeBlockAuthorFee({
    workflowId: unlockAuthorFeeAnchor(ctx.workflowId),
    appId: ctx.appId,
    appBlockId: ctx.appBlockId,
    viewerUserId: ctx.viewerUserId,
    buzzType: 'yellow',
    baseGenerationBuzz: ctx.original.baseGenerationBuzz,
    priceIsCap: false,
    generationType: ctx.original.generationType,
    reservedAuthorFeeBuzz: ctx.reservedAuthorFeeBuzz,
    privateRun: ctx.privateRun,
  });
  return result.charged ? result.feeBuzz : 0;
}
