import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';
import { OPEN_DEPOSIT_DIGEST_AFTER_DAYS } from '~/server/common/chain-config';

export type OpenDepositDigestItem = {
  paymentId: string;
  userId: number;
  username: string;
  status: string;
  payCurrency: string;
  payAmount: number | null;
  daysOpen: number;
  held: boolean;
};

/** Where the watch left a payment id support listed for it (nowpayments:watch-payment-ids). */
export type ListedPaymentState =
  | 'no_row' // NowPayments still has it waiting; no row yet
  | 'awaiting_ok' // complete at NowPayments, not on the credit-ok list: not credited
  | 'recorded' // processed this run: it now has a row
  | 'has_row' // has a row the watch already follows
  | 'held' // held for review; left alone
  | 'lookup_failed'; // NowPayments could not be read

export type ListedPaymentDigestItem = {
  paymentId: string;
  state: ListedPaymentState;
  /** NowPayments' status when it was read this run, else the row's. */
  status: string | null;
};

const LISTED_STATE_LABEL: Record<ListedPaymentState, string> = {
  no_row: 'no row yet, waiting at NowPayments',
  awaiting_ok: 'complete, awaiting confirmation (not credited)',
  recorded: 'now has a row',
  has_row: 'has a row',
  held: 'held for review',
  lookup_failed: 'NowPayments lookup failed',
};

export type OpenCryptoDepositDigestData = {
  to: string;
  items: OpenDepositDigestItem[];
  /** Listed payment ids and where each stands; empty when none are listed. */
  listed?: ListedPaymentDigestItem[];
  counts: { open: number; oldestOpenDays: number; held: number; finishedUncredited: number };
};

const received = (i: OpenDepositDigestItem) =>
  i.payAmount != null
    ? `${i.payAmount} ${i.payCurrency.toUpperCase()}`
    : i.payCurrency.toUpperCase();

const summary = ({ counts }: OpenCryptoDepositDigestData) =>
  `Open: ${counts.open}, oldest ${counts.oldestOpenDays} days. Held for review: ${counts.held}. Finished but uncredited: ${counts.finishedUncredited}.`;

const listedLine = (i: ListedPaymentDigestItem) =>
  `Payment ${i.paymentId}: ${LISTED_STATE_LABEL[i.state]}${i.status ? ` (${i.status})` : ''}`;

export const openCryptoDepositDigestEmail = createEmail({
  header: ({ to, items, listed }: OpenCryptoDepositDigestData) => ({
    subject: `NP open-payment digest: ${items.length} crypto deposit${
      items.length === 1 ? '' : 's'
    } still open${listed?.length ? `, ${listed.length} listed` : ''}`,
    to,
    from: 'Civitai Support <hello@civitai.com>',
  }),
  html(data: OpenCryptoDepositDigestData) {
    const rows = data.items
      .map(
        (i) => `
        <tr>
          <td style="padding:6px; border-bottom:1px solid #eee;">${i.paymentId}</td>
          <td style="padding:6px; border-bottom:1px solid #eee;">${i.username} (${i.userId})</td>
          <td style="padding:6px; border-bottom:1px solid #eee;">${received(i)}</td>
          <td style="padding:6px; border-bottom:1px solid #eee;">${i.status}</td>
          <td style="padding:6px; border-bottom:1px solid #eee;">${i.daysOpen}</td>
        </tr>`
      )
      .join('');
    return simpleEmailWithTemplate({
      header: `${data.items.length} crypto deposit${data.items.length === 1 ? '' : 's'} still open`,
      body: `
      <p>
        NowPayments received money for these deposits, but after ${OPEN_DEPOSIT_DIGEST_AFTER_DAYS}+ days the payment has not
        finished, so no Buzz has been credited. They are checked again every day and credited
        automatically if they finish.
      </p>
      <p>${summary(data)}</p>${
        data.listed?.length
          ? `
      <p>Listed payment ids (no IPN row):</p>
      <ul>${data.listed.map((i) => `<li>${listedLine(i)}</li>`).join('')}</ul>`
          : ''
      }
      <div style="overflow-x:auto;">
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:13px; min-width:520px;">
          <thead>
            <tr style="text-align:left; border-bottom:2px solid #ddd;">
              <th style="padding:6px;">Payment ID</th>
              <th style="padding:6px;">User</th>
              <th style="padding:6px;">Received</th>
              <th style="padding:6px;">NP status</th>
              <th style="padding:6px;">Days open</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`,
    });
  },
  text(data: OpenCryptoDepositDigestData) {
    const lines = data.items.map(
      (i) =>
        `- Payment ${i.paymentId} | ${i.username} (${i.userId}) | ${received(i)} | ${i.status} | ${
          i.daysOpen
        } days open`
    );
    return [
      `${data.items.length} crypto deposit(s) received money at NowPayments but have not finished after ${OPEN_DEPOSIT_DIGEST_AFTER_DAYS}+ days, so no Buzz has been credited. They are checked daily and credited automatically if they finish.`,
      summary(data),
      ...lines,
      ...(data.listed?.length
        ? ['Listed payment ids (no IPN row):', ...data.listed.map((i) => `- ${listedLine(i)}`)]
        : []),
    ].join('\n');
  },
  testData: async () => ({
    to: 'hello@civitai.com',
    items: [
      {
        paymentId: '1000000001',
        userId: 1,
        username: 'Testerson',
        status: 'confirmed',
        payCurrency: 'usdcbase',
        payAmount: 4.99,
        daysOpen: 5,
        held: false,
      },
    ],
    counts: { open: 1, oldestOpenDays: 5, held: 0, finishedUncredited: 0 },
  }),
});
