import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';

// Category 3 (unsupported / wrapped token, e.g. cbBTC): NP cannot convert the
// funds to our USDC payout, so only NP can refund them and they require the
// account holder (the user) to request it. We email the USER a self-service
// packet + NP's verification requirements; they contact NP support themselves.
export type StuckCryptoDepositUserData = {
  userEmail: string;
  npSupportEmail: string;
  username: string;
  paymentId: string;
  payCurrency: string;
  payAmount: number | null;
  payAddress?: string | null;
  payinHash?: string | null;
  network?: string | null;
};

const sent = ({ payAmount, payCurrency, network }: StuckCryptoDepositUserData) => {
  const amount = payAmount != null ? `${payAmount} ${payCurrency.toUpperCase()}` : payCurrency.toUpperCase();
  return network ? `${amount} on ${network}` : amount;
};

export const stuckCryptoDepositUserEmail = createEmail({
  header: ({ userEmail }: StuckCryptoDepositUserData) => ({
    subject: 'Your Civitai crypto deposit needs a refund from NowPayments',
    to: userEmail,
    from: 'Civitai Support <hello@civitai.com>',
  }),
  html(data: StuckCryptoDepositUserData) {
    const { username, npSupportEmail, paymentId, payCurrency, payAddress, payinHash } = data;
    const details = [
      `Payment ID: ${paymentId}`,
      payAddress ? `Deposit address: ${payAddress}` : null,
      `Sent: ${sent(data)}`,
      payinHash ? `TXID: ${payinHash}` : null,
    ].filter(Boolean).join('\n');
    return simpleEmailWithTemplate({
      header: 'Your crypto deposit needs a refund from NowPayments',
      body: `
      <p>Hi ${username},</p>
      <p>
        Your recent crypto deposit to Civitai arrived in a token / network we can't accept
        (a wrapped or unsupported coin, in this case <strong>${payCurrency.toUpperCase()}</strong>).
        It could not be converted, so no Buzz was credited. These funds are held by our payment
        processor, <strong>NowPayments</strong>, and only they can return them to you.
      </p>
      <p>
        To get your refund, email
        <a href="mailto:${npSupportEmail}">${npSupportEmail}</a> with the details below.
        NowPayments will also ask you to provide:
      </p>
      <ul style="font-size:14px; line-height:22px; padding-left:18px;">
        <li>A personal wallet address <strong>on the same network you paid from</strong> (to receive the refund)</li>
        <li>A short <strong>video of your withdrawal record</strong> showing the TxID, payin address, token, amount, and date</li>
      </ul>
      <p style="margin-bottom:6px;">Your deposit details (copy and paste these to NowPayments):</p>
      <div style="background:#f4f4f4; border-radius:6px; padding:12px; font-family:Menlo,Consolas,monospace; font-size:13px; line-height:20px; white-space:pre-wrap;">${details}</div>
      <p>
        If you have any questions, just reach us at
        <a href="mailto:hello@civitai.com">hello@civitai.com</a> and we'll help however we can.
      </p>
      <p>Thanks,<br/>Civitai Support</p>`,
    });
  },
  text(data: StuckCryptoDepositUserData) {
    const { username, npSupportEmail, paymentId, payCurrency, payAddress, payinHash } = data;
    const details = [
      `Payment ID: ${paymentId}`,
      payAddress ? `Deposit address: ${payAddress}` : null,
      `Sent: ${sent(data)}`,
      payinHash ? `TXID: ${payinHash}` : null,
    ].filter(Boolean).join('\n');
    return [
      `Hi ${username},`,
      `Your recent crypto deposit to Civitai arrived in a token/network we can't accept (a wrapped or unsupported coin, in this case ${payCurrency.toUpperCase()}). It could not be converted, so no Buzz was credited. These funds are held by our payment processor, NowPayments, and only they can return them to you.`,
      `To get your refund, email ${npSupportEmail} with the details below. NowPayments will also ask you to provide:`,
      `- A personal wallet address on the same network you paid from (to receive the refund)`,
      `- A short video of your withdrawal record showing the TxID, payin address, token, amount, and date`,
      `Your deposit details (copy and paste these to NowPayments):`,
      details,
      `Questions? Reach us at hello@civitai.com.`,
      `Thanks,\nCivitai Support`,
    ].join('\n\n');
  },
  testData: async () => ({
    userEmail: 'user@example.com',
    npSupportEmail: 'support@nowpayments.io',
    username: 'Testerson',
    paymentId: '4939862197',
    payCurrency: 'cbbtcbase',
    payAmount: 0.00007875,
    payAddress: '0x14535521BEfBBEEAC38F6056B960041F299FcAb3',
    payinHash: '0x89673dfe3f3123f2724d89172abc28b2132b193b29d0b210f540e5b3cb36fbea',
    network: 'base',
  }),
});
