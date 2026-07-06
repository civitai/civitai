import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';

export type StuckCryptoDepositData = {
  supportEmail: string;
  userEmail: string;
  username: string;
  paymentId: string;
  payCurrency: string;
  payAmount: number | null;
  payAddress?: string | null;
  payinHash?: string | null;
  network?: string | null;
};

const receivedLine = ({ payAmount, payCurrency, network }: StuckCryptoDepositData) => {
  const amount = payAmount != null ? `${payAmount} ${payCurrency.toUpperCase()}` : payCurrency.toUpperCase();
  return network ? `${amount} on ${network}` : amount;
};

export const stuckCryptoDepositEmail = createEmail({
  header: ({ supportEmail, userEmail, paymentId }: StuckCryptoDepositData) => ({
    subject: `Unprocessed crypto deposit ${paymentId} - wrong token / network`,
    to: supportEmail,
    cc: userEmail,
  }),
  html(data: StuckCryptoDepositData) {
    const { username, paymentId, payAddress, payinHash } = data;
    return simpleEmailWithTemplate({
      header: 'Crypto deposit needs manual processing',
      body: `
      <p>Hi NowPayments team,</p>
      <p>
        A user sent the wrong token / network to their deposit address, so the funds were not
        processed. Could you please review and either convert them to the intended currency
        (USDC on Base) or return them to the user?
      </p>
      <ul style="font-size:14px; line-height:22px; padding-left:18px;">
        <li><strong>Payment ID:</strong> ${paymentId}</li>
        ${payAddress ? `<li><strong>Deposit address (USDC on Base intent):</strong> ${payAddress}</li>` : ''}
        <li><strong>Received:</strong> ${receivedLine(data)}</li>
        ${payinHash ? `<li><strong>TXID:</strong> ${payinHash}</li>` : ''}
      </ul>
      <p>
        <strong>${username}</strong> - you are copied here so you can follow the resolution directly
        with NowPayments. If you have any questions on our end, reach us at
        <a href="mailto:hello@civitai.com">hello@civitai.com</a>.
      </p>
      <p>Thank you,<br/>Civitai Support</p>`,
    });
  },
  text(data: StuckCryptoDepositData) {
    const { username, paymentId, payAddress, payinHash } = data;
    return [
      `A user (${username}, CC'd) sent the wrong token / network to their deposit address, so the funds were not processed. Please review and either convert them to the intended currency (USDC on Base) or return them to the user.`,
      `Payment ID: ${paymentId}`,
      payAddress ? `Deposit address (USDC on Base intent): ${payAddress}` : '',
      `Received: ${receivedLine(data)}`,
      payinHash ? `TXID: ${payinHash}` : '',
      `Questions for Civitai: hello@civitai.com`,
    ].filter(Boolean).join('\n');
  },
  testData: async () => ({
    supportEmail: 'support@nowpayments.io',
    userEmail: 'user@example.com',
    username: 'Testerson',
    paymentId: '4939862197',
    payCurrency: 'usdtbsc',
    payAmount: 4.99,
    payAddress: '0xdDF56A6bd403b8F5E899CA47d25Cf161D2fED7d0',
    payinHash: '0x9b7a7a7a3098aacf749f57bad71ff4be71f113f7c5c5258254776e0d9c6f09af',
    network: 'bsc',
  }),
});
