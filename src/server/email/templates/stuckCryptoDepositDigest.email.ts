import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';

// Category 2 (convertible wrong-network, e.g. USDT-BSC -> USDC-Base): NP produced
// a USDC conversion but the payment didn't settle. The signal is fuzzier than the
// unsupported-coin case, so instead of emailing NP directly we send the support
// team one digest to review and forward to NP (convert-or-return).
export type StuckCryptoDepositDigestItem = {
  paymentId: string;
  username: string;
  userId: number;
  payCurrency: string;
  payAmount: number | null;
  payAddress?: string | null;
  payinHash?: string | null;
  network?: string | null;
  outcomeAmount?: number | null;
};

export type StuckCryptoDepositDigestData = {
  to: string;
  npSupportEmail: string;
  items: StuckCryptoDepositDigestItem[];
};

const received = (i: StuckCryptoDepositDigestItem) => {
  const amount = i.payAmount != null ? `${i.payAmount} ${i.payCurrency.toUpperCase()}` : i.payCurrency.toUpperCase();
  return i.network ? `${amount} on ${i.network}` : amount;
};

export const stuckCryptoDepositDigestEmail = createEmail({
  header: ({ to, items }: StuckCryptoDepositDigestData) => ({
    subject: `Crypto deposits needing NowPayments follow-up (${items.length})`,
    to,
    from: 'Civitai Support <hello@civitai.com>',
  }),
  html({ npSupportEmail, items }: StuckCryptoDepositDigestData) {
    const rows = items
      .map(
        (i) => `
        <tr>
          <td style="padding:6px; border-bottom:1px solid #eee;">${i.paymentId}</td>
          <td style="padding:6px; border-bottom:1px solid #eee;">${i.username} (${i.userId})</td>
          <td style="padding:6px; border-bottom:1px solid #eee;">${received(i)}</td>
          <td style="padding:6px; border-bottom:1px solid #eee;">${i.outcomeAmount != null ? `~${i.outcomeAmount} USDC` : '-'}</td>
          <td style="padding:6px; border-bottom:1px solid #eee; font-family:Menlo,Consolas,monospace; font-size:12px;">${i.payAddress ?? '-'}</td>
          <td style="padding:6px; border-bottom:1px solid #eee; font-family:Menlo,Consolas,monospace; font-size:12px;">${i.payinHash ?? '-'}</td>
        </tr>`
      )
      .join('');
    return simpleEmailWithTemplate({
      header: `${items.length} crypto deposit${items.length === 1 ? '' : 's'} to review`,
      body: `
      <p>
        These deposits came in on the wrong network but appear <strong>convertible</strong> — NowPayments
        produced a USDC conversion, but the payment did not settle, so no Buzz was credited. Please review
        each, and if valid, forward to
        <a href="mailto:${npSupportEmail}">${npSupportEmail}</a> asking them to convert the funds to USDC
        or return them to the user.
      </p>
      <div style="overflow-x:auto;">
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:13px; min-width:640px;">
          <thead>
            <tr style="text-align:left; border-bottom:2px solid #ddd;">
              <th style="padding:6px;">Payment ID</th>
              <th style="padding:6px;">User</th>
              <th style="padding:6px;">Received</th>
              <th style="padding:6px;">NP outcome</th>
              <th style="padding:6px;">Deposit address</th>
              <th style="padding:6px;">TXID</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`,
    });
  },
  text({ npSupportEmail, items }: StuckCryptoDepositDigestData) {
    const lines = items.map(
      (i) =>
        `- Payment ${i.paymentId} | ${i.username} (${i.userId}) | ${received(i)} | outcome ${
          i.outcomeAmount != null ? `~${i.outcomeAmount} USDC` : '-'
        } | address ${i.payAddress ?? '-'} | TXID ${i.payinHash ?? '-'}`
    );
    return [
      `${items.length} crypto deposit(s) came in on the wrong network but appear convertible (NowPayments produced a USDC conversion but the payment did not settle, so no Buzz was credited). Review each and, if valid, forward to ${npSupportEmail} to convert to USDC or return the funds.`,
      ...lines,
    ].join('\n');
  },
  testData: async () => ({
    to: 'hello@civitai.com',
    npSupportEmail: 'support@nowpayments.io',
    items: [
      {
        paymentId: '4939862197',
        username: 'Testerson',
        userId: 9462069,
        payCurrency: 'usdtbsc',
        payAmount: 4.99,
        payAddress: '0xdDF56A6bd403b8F5E899CA47d25Cf161D2fED7d0',
        payinHash: '0x9b7a7a7a3098aacf749f57bad71ff4be71f113f7c5c5258254776e0d9c6f09af',
        network: 'bsc',
        outcomeAmount: 4.87,
      },
    ],
  }),
});
