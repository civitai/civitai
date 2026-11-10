import type { ManualCreditMatch } from '~/server/services/nowpayments-manual-credit';
import { runScriptAndExit } from './lib/run-as-script';

/**
 * For each NowPayments payment id, print what the deposit flow would decide right now — already
 * granted (and how), held, or how much it would grant — WITHOUT crediting or writing anything. It
 * runs the flow's own `decideDepositCredit`: the payin-hash and `np-deposit-<id>` ledger checks, then
 * the hand-grant scan.
 *
 *   pnpm run tsscript scripts/nowpayments-settle-dry-run.ts <paymentId> [<paymentId> ...]
 *
 * Reads only:
 *   - Postgres through `dbRead`; the script refuses to run unless that server is a standby
 *     (`pg_is_in_recovery()`), so it cannot write there.
 *   - the buzz ledger through the buzz service's GET endpoints (transaction by external id, account
 *     transactions).
 *   - NowPayments `GET /payment/<id>`, for the payin hash, settled amount and creation time. A
 *     failed lookup is logged to Axiom by the caller; nothing else is written.
 *
 * Environment (the server env schema is validated on import, so its other required vars must be
 * set too):
 *   DATABASE_REPLICA_URL   a standby; set DATABASE_URL to the same standby
 *   BUZZ_ENDPOINT          the buzz service
 *   NOW_PAYMENTS_API_URL, NOW_PAYMENTS_API_KEY
 */

async function main() {
  const ids = process.argv.slice(2).map(Number);
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
    throw new Error('usage: nowpayments-settle-dry-run.ts <paymentId> [<paymentId> ...]');

  const { dbRead } = await import('~/server/db/client');
  const [{ standby }] = await dbRead.$queryRaw<
    { standby: boolean }[]
  >`SELECT pg_is_in_recovery() AS standby`;
  if (!standby) throw new Error('dbRead is not a standby; refusing to run');

  const { default: nowpaymentsCaller } = await import(
    '~/server/http/nowpayments/nowpayments.caller'
  );
  const { decideDepositCredit, LATE_FINISH_STATUSES, userIdFromOrderId } = await import(
    '~/server/services/nowpayments-settle-decision'
  );
  const { outcomeAmountToBuzz, isDepositComplete } = await import('~/server/common/chain-config');

  for (const paymentId of ids) {
    try {
      const payment = await nowpaymentsCaller.getPaymentStatus(paymentId);
      if (!payment) {
        console.log(`${paymentId} not found on NowPayments`);
        continue;
      }
      const userId = userIdFromOrderId(payment.order_id);
      const row = await dbRead.cryptoDeposit.findUnique({
        where: { paymentId: BigInt(paymentId) },
        select: { status: true, createdAt: true },
      });
      const header = `${paymentId} np=${payment.payment_status} row=${row?.status ?? 'none'}`;
      if (!userId) {
        console.log(`${header} not a Civitai deposit (order id)`);
        continue;
      }
      if (!isDepositComplete(payment.payment_status) || !payment.outcome_amount) {
        console.log(`${header} nothing to credit yet`);
        continue;
      }
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
      });
      const describe = (m: ManualCreditMatch) =>
        `${m.type} ${m.amount} ${m.ref} (${m.why}) sender=${m.fromAccountId} staff=${m.fromStaff}`;
      if (decision.decision === 'already_granted')
        console.log(
          `${header} already_granted via ${decision.via}` +
            (decision.ledgerAmount != null ? ` (ledger ${decision.ledgerAmount})` : '') +
            decision.matches.map((m) => `\n    ${describe(m)}`).join('')
        );
      else if (decision.decision === 'held')
        console.log(
          `${header} held ${decision.reason ?? 'already held'}` +
            decision.matches.map((m) => `\n    ${describe(m)}`).join('') +
            (decision.unscanned.length ? `\n    unscanned: ${decision.unscanned.join(', ')}` : '')
        );
      else
        console.log(
          `${header} would grant ${expectedBuzz}` +
            decision.possible.map((m) => `\n    possible: ${describe(m)}`).join('') +
            (decision.unscanned.length ? `\n    unscanned: ${decision.unscanned.join(', ')}` : '')
        );
    } catch (e) {
      console.log(`${paymentId} error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await dbRead.$disconnect();
}

void runScriptAndExit(main);
