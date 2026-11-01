import { describe, expect, it } from 'vitest';
import { TransactionType } from '~/shared/constants/buzz.constants';
import {
  getTransactionBadgeLabel,
  getTransactionDescription,
  mergeWorkflowRefunds,
  mergeWorkflowRefundsByPage,
} from '~/utils/buzz-transaction-display';

// Every amount, account id, workflow id and timestamp below is pairwise distinct (and distinct from
// one another across kinds), so a mutant that pairs the wrong rows or sums the wrong amounts moves a
// value these assertions pin.
const ME = 9301;
const OTHER = 9417;

function charge(workflowId: string, amount: number, at: string, accountType = 'yellow') {
  return {
    type: TransactionType.Generation,
    date: new Date(at),
    amount: -amount,
    fromAccountId: ME,
    toAccountId: 0,
    fromAccountType: accountType,
    toAccountType: accountType,
    description: `charge ${workflowId}`,
    details: { workflowId },
    externalTransactionId: null as string | null,
  };
}

function refund(
  workflowId: string,
  amount: number,
  at: string,
  { accountId = ME, accountType = 'yellow' }: { accountId?: number; accountType?: string } = {}
) {
  return {
    type: TransactionType.Refund,
    date: new Date(at),
    amount,
    fromAccountId: 0,
    toAccountId: accountId,
    fromAccountType: accountType,
    toAccountType: accountType,
    description: `refund ${workflowId}`,
    details: { workflowId } as Record<string, unknown> | null,
    externalTransactionId: `refund-${accountId}-${workflowId}` as string | null,
  };
}

const chargeAlpha = charge('wf-alpha', 37, '2026-10-30T10:00:03Z');
const refundAlpha = refund('wf-alpha', 29, '2026-10-30T10:00:47Z');
const chargeBravo = charge('wf-bravo', 53, '2026-10-30T10:01:05Z');
const refundBravo = refund('wf-bravo', 41, '2026-10-30T10:01:59Z');

describe('mergeWorkflowRefunds', () => {
  it('folds a refund into its generation charge: net amount, charge time, gross + refund kept', () => {
    // Newest first, as the page lists them: the refund lands after the charge.
    const merged = mergeWorkflowRefunds([refundAlpha, chargeAlpha]);

    expect(merged).toEqual([
      {
        ...chargeAlpha,
        amount: -8,
        workflowRefund: {
          grossAmount: -37,
          refundAmount: 29,
          refundDate: new Date('2026-10-30T10:00:47Z'),
        },
      },
    ]);
    expect(merged[0].date).toEqual(new Date('2026-10-30T10:00:03Z'));
  });

  it('renders an orphan refund exactly as today', () => {
    const rows = [refundAlpha];
    const merged = mergeWorkflowRefunds(rows);
    expect(merged).toEqual([refundAlpha]);
    expect(merged[0]).toBe(refundAlpha);
  });

  it('renders an orphan charge exactly as today', () => {
    const merged = mergeWorkflowRefunds([chargeAlpha]);
    expect(merged).toEqual([chargeAlpha]);
    expect(merged[0]).toBe(chargeAlpha);
  });

  it('does not pair a refund with a charge for a different workflow id', () => {
    const refundOmega = refund('wf-omega', 23, '2026-10-30T10:02:11Z');
    const merged = mergeWorkflowRefunds([refundOmega, chargeAlpha]);
    expect(merged).toEqual([refundOmega, chargeAlpha]);
  });

  it('pairs two interleaved workflows each with its own refund', () => {
    const merged = mergeWorkflowRefunds([refundBravo, refundAlpha, chargeBravo, chargeAlpha]);

    expect(merged.map((row) => [row.description, row.amount, row.workflowRefund])).toEqual([
      [
        'charge wf-bravo',
        -12,
        { grossAmount: -53, refundAmount: 41, refundDate: new Date('2026-10-30T10:01:59Z') },
      ],
      [
        'charge wf-alpha',
        -8,
        { grossAmount: -37, refundAmount: 29, refundDate: new Date('2026-10-30T10:00:47Z') },
      ],
    ]);
  });

  it('leaves a pair split across pages unmerged, without merging across the page boundary', () => {
    const merged = mergeWorkflowRefundsByPage([
      [refundAlpha, chargeBravo, refundBravo],
      [chargeAlpha],
    ]);

    expect(merged.map((row) => [row.description, row.amount])).toEqual([
      ['refund wf-alpha', 29],
      ['charge wf-bravo', -12],
      ['charge wf-alpha', -37],
    ]);
    expect(merged[0]).toBe(refundAlpha);
    expect(merged[2]).toBe(chargeAlpha);
  });

  it('never pairs across accounts', () => {
    const elsewhere = refund('wf-alpha', 19, '2026-10-30T10:03:13Z', { accountId: OTHER });
    expect(mergeWorkflowRefunds([elsewhere, chargeAlpha])).toEqual([elsewhere, chargeAlpha]);
  });

  it('never pairs across currency types', () => {
    const blue = refund('wf-alpha', 17, '2026-10-30T10:04:17Z', { accountType: 'blue' });
    expect(mergeWorkflowRefunds([blue, chargeAlpha])).toEqual([blue, chargeAlpha]);
  });

  it('leaves every row alone when a workflow has more than one refund or charge', () => {
    const second = refund('wf-alpha', 13, '2026-10-30T10:05:19Z');
    expect(mergeWorkflowRefunds([second, refundAlpha, chargeAlpha])).toEqual([
      second,
      refundAlpha,
      chargeAlpha,
    ]);
    const again = charge('wf-alpha', 61, '2026-10-30T09:59:31Z');
    expect(mergeWorkflowRefunds([refundAlpha, chargeAlpha, again])).toEqual([
      refundAlpha,
      chargeAlpha,
      again,
    ]);
  });

  it('identifies the refund by its external id when its details carry no workflow id', () => {
    const bare = { ...refundAlpha, details: null };
    expect(mergeWorkflowRefunds([bare, chargeAlpha])).toEqual([
      {
        ...chargeAlpha,
        amount: -8,
        workflowRefund: {
          grossAmount: -37,
          refundAmount: 29,
          refundDate: new Date('2026-10-30T10:00:47Z'),
        },
      },
    ]);
  });

  it('does not pair when the refund details and external id name different workflows', () => {
    const conflicted = { ...refundAlpha, externalTransactionId: `refund-${ME}-wf-bravo` };
    expect(mergeWorkflowRefunds([conflicted, chargeAlpha])).toEqual([conflicted, chargeAlpha]);
  });

  it('only pairs a Refund with a Generation charge', () => {
    const fee = { ...chargeAlpha, type: TransactionType.AppAuthorFee };
    expect(mergeWorkflowRefunds([refundAlpha, fee])).toEqual([refundAlpha, fee]);
  });
});

describe('merged row label', () => {
  it('names the refunded amount on a merged row and leaves other rows alone', () => {
    const [merged] = mergeWorkflowRefunds([refundAlpha, chargeAlpha]);
    expect(getTransactionBadgeLabel(merged)).toBe('Generation (refunded 29)');
    expect(getTransactionBadgeLabel(chargeAlpha)).toBe('Generation');
    expect(getTransactionBadgeLabel(refundAlpha)).toBe('Refund');
  });
});

describe('transaction description', () => {
  it('keeps "Content" inside a model name intact', () => {
    // parseBuzzTransactionDetails labels {workflowId} details 'User', which used to turn this into
    // "AI chat: A userWriter".
    const row = { type: TransactionType.Generation, description: 'AI chat: ContentWriter' };
    expect(getTransactionDescription(row, 'User')).toBe('AI chat: ContentWriter');
  });

  it('still names the entity on the reward descriptions the replace was written for', () => {
    const row = {
      type: TransactionType.Reward,
      description: 'Content that you posted was liked by someone else',
    };
    expect(getTransactionDescription(row, 'Comment')).toBe(
      'A comment that you posted was liked by someone else'
    );
  });

  it('shows the charge description on a merged row, not the refund one', () => {
    const chat = { ...chargeAlpha, description: 'AI chat: ContentWriter' };
    const chatRefund = { ...refundAlpha, description: 'Refund: AI chat: ContentWriter' };
    const [merged] = mergeWorkflowRefunds([chatRefund, chat]);
    expect(getTransactionDescription(merged, 'User')).toBe('AI chat: ContentWriter');
  });

  it('falls back to the type label on a merged row with no description', () => {
    const bare = { ...chargeAlpha, description: '' };
    const [merged] = mergeWorkflowRefunds([refundAlpha, bare]);
    expect(merged.workflowRefund?.refundAmount).toBe(29);
    expect(getTransactionDescription(merged, 'User')).toBe('Generation');
  });

  it('leaves an unmerged row with no description blank, as today', () => {
    const row = { type: TransactionType.Generation, description: null };
    expect(getTransactionDescription(row, 'User')).toBeUndefined();
  });
});
