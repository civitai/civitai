import type { ManualCreditMatch } from '~/server/services/nowpayments-manual-credit';
import { runScriptAndExit } from './lib/run-as-script';

/**
 * For each NowPayments payment id, print what the deposit flow would decide right now — already
 * granted (and how), held, or how much it would grant — WITHOUT crediting or writing anything. It
 * runs the flow's own `decideDepositCredit`: the payin-hash and `np-deposit-<id>` ledger checks, then
 * the hand-grant scan.
 *
 *   pnpm run tsscript scripts/nowpayments-settle-dry-run.ts [--control-ignore-prior-grant]
 *     <paymentId> [<paymentId> ...]
 *
 * --control-ignore-prior-grant skips only the payin-hash and `np-deposit-<id>` checks, so the
 * hand-grant scan runs on a deposit that was credited normally (a control for the scan: such a
 * deposit must come out "would grant"). Every line it prints starts `[control: prior grant ignored]`.
 *
 * Reads only:
 *   - Postgres through `dbRead`. It asserts dbRead is a standby (`pg_is_in_recovery()`) around every
 *     payment and exits non-zero without printing that payment's decision if not.
 *   - the buzz ledger through the buzz service's GET endpoints (transaction by external id, account
 *     transactions).
 *   - NowPayments `GET /payment/<id>`, for the payin hash, settled amount and creation time.
 *
 * Environment (the server env schema is validated on import, so its other required vars must be
 * set too):
 *   DATABASE_REPLICA_URL   a standby; set DATABASE_URL to the same standby
 *   BUZZ_ENDPOINT          the buzz service
 *   NOW_PAYMENTS_API_URL, NOW_PAYMENTS_API_KEY
 */

const CONTROL_FLAG = '--control-ignore-prior-grant';

async function main() {
  const args = process.argv.slice(2);
  const ignorePriorGrant = args.includes(CONTROL_FLAG);
  const ids = args.filter((a) => a !== CONTROL_FLAG).map(Number);
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
    throw new Error(
      `usage: nowpayments-settle-dry-run.ts [${CONTROL_FLAG}] <paymentId> [<paymentId> ...]`
    );
  const prefix = ignorePriorGrant ? '[control: prior grant ignored] ' : '';

  const { dbRead } = await import('~/server/db/client');
  const assertStandby = async (when: string) => {
    const [{ standby }] = await dbRead.$queryRaw<
      { standby: boolean }[]
    >`SELECT pg_is_in_recovery() AS standby`;
    if (!standby) {
      console.log(`dbRead is not a standby (${when}); stopping`);
      throw new Error('dbRead is not a standby');
    }
  };
  await assertStandby('at start');

  const { default: nowpaymentsCaller } = await import(
    '~/server/http/nowpayments/nowpayments.caller'
  );
  const { decideDepositCredit, LATE_FINISH_STATUSES, userIdFromOrderId } = await import(
    '~/server/services/nowpayments-settle-decision'
  );
  const { outcomeAmountToBuzz, isDepositComplete } = await import('~/server/common/chain-config');
  const describe = (m: ManualCreditMatch) =>
    `${m.type} ${m.amount} ${m.ref} (${m.why}) sender=${m.fromAccountId} staff=${m.fromStaff}`;

  for (const paymentId of ids) {
    await assertStandby(`before ${paymentId}`);
    let line: string;
    try {
      line = await decideOne(paymentId);
    } catch (e) {
      line = `${paymentId} error: ${e instanceof Error ? e.message : String(e)}`;
    }
    await assertStandby(`after ${paymentId}`);
    console.log(prefix + line);
  }
  await assertStandby('at end');
  await dbRead.$disconnect();

  async function decideOne(paymentId: number) {
    const payment = await nowpaymentsCaller.getPaymentStatus(paymentId);
    if (!payment) return `${paymentId} not found on NowPayments`;
    const userId = userIdFromOrderId(payment.order_id);
    const row = await dbRead.cryptoDeposit.findUnique({
      where: { paymentId: BigInt(paymentId) },
      select: { status: true, createdAt: true },
    });
    const header = `${paymentId} np=${payment.payment_status} row=${row?.status ?? 'none'}`;
    if (!userId) return `${header} not a Civitai deposit (order id)`;
    if (!isDepositComplete(payment.payment_status) || !payment.outcome_amount)
      return `${header} nothing to credit yet`;

    const expectedBuzz = outcomeAmountToBuzz(payment.outcome_amount);
    const decision = await decideDepositCredit({
      paymentId,
      userId,
      payinHash: payment.payin_hash ?? null,
      expectedBuzz,
      paymentCreatedAt: payment.created_at,
      row,
      lateStatus: row && LATE_FINISH_STATUSES.includes(row.status) ? row.status : undefined,
      byModerator: false,
      ignorePriorGrant,
    });
    const listed = (ms: ManualCreditMatch[], label = '') =>
      ms.map((m) => `\n    ${prefix}${label}${describe(m)}`).join('');
    const unscanned = (u: string[]) =>
      u.length ? `\n    ${prefix}unscanned: ${u.join(', ')}` : '';

    if (decision.decision === 'already_granted')
      return (
        `${header} already_granted via ${decision.via}` +
        (decision.ledgerAmount != null ? ` (ledger ${decision.ledgerAmount})` : '') +
        listed(decision.matches)
      );
    if (decision.decision === 'held')
      return (
        `${header} held ${decision.reason ?? 'already held'}` +
        listed(decision.matches) +
        unscanned(decision.unscanned)
      );
    return (
      `${header} would grant ${expectedBuzz}` +
      listed(decision.possible, 'possible: ') +
      unscanned(decision.unscanned)
    );
  }
}

void runScriptAndExit(main);
