#!/usr/bin/env node

/**
 * Creator Shop moderation - CLI for refunding shop purchases.
 *
 * Commands:
 *   refund <buzzTransactionId...>     Refund purchases (creatorShop.refundPurchases)
 */

import { createCli, trpcCall } from './lib.mjs';

const cli = createCli(['clawback', 'no-clawback', 'writable', 'json']);
const { positional, flags, writable, fail, required } = cli;

const help = `Usage: node shop.mjs refund <buzzTransactionId...> --reason <text> (--clawback | --no-clawback) [--writable] [--json]

  --reason <text>    Required. Recorded in Axiom only; the creator can read the item history.
  --clawback         Also reverse the creator's payouts, so the creator pays.
  --no-clawback      Refund the buyer only; the platform pays.
  --writable         Move the money. Without it the server returns a dry run.
  --json             Print the raw result.

Example:
  node .claude/skills/mod-actions/shop.mjs refund cm1abc cm1def --reason "chargeback" --clawback`;

function format({ dryRun, totals, results }) {
  const lines = [dryRun ? 'DRY RUN, nothing moved' : 'Refund run'];
  for (const r of results) {
    lines.push(`- ${r.buzzTransactionId}  ${r.status}${r.error ? `: ${r.error}` : ''}`);
    for (const leg of r.legs ?? [])
      lines.push(
        `    ${leg.kind} ${leg.transactionId} account ${leg.accountId} amount ${leg.amount}${
          leg.alreadyRefunded ? ' (already refunded)' : ''
        }`
      );
    if (r.status === 'refunded')
      lines.push(`    refunded ${r.refunded}, clawed back ${r.clawedBack}`);
    for (const f of r.payoutFailures ?? [])
      lines.push(`    payout ${f.transactionId} NOT reversed: ${f.error}`);
  }
  lines.push(JSON.stringify(totals));
  return lines.join('\n');
}

cli.dispatch(
  {
    refund: async () => {
      const buzzTransactionIds = positional.slice(1);
      if (!buzzTransactionIds.length) fail('give at least one buzzTransactionId');
      if (!!flags.clawback === !!flags['no-clawback'])
        fail('pass exactly one of --clawback or --no-clawback');
      const result = await trpcCall('creatorShop.refundPurchases', {
        buzzTransactionIds,
        clawback: !!flags.clawback,
        reason: required('reason'),
        dryRun: !writable,
      });
      console.log(flags.json ? JSON.stringify(result, null, 2) : format(result));
    },
  },
  help
);
