import { createJob } from './job';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

const SWEEP_THRESHOLD = 5; // Only sweep if balance > $5
const SWEEP_BUFFER = 1; // Leave $1 in custody

export const custodySweepJob = createJob(
  'custody-sweep',
  '0 4 * * *', // Daily at 04:00 UTC
  async () => {
    if (
      !env.NOW_PAYMENTS_EMAIL ||
      !env.NOW_PAYMENTS_PASSWORD ||
      !env.NOW_PAYMENTS_PAYOUT_ADDRESS
    ) {
      return { skipped: true, reason: 'Missing payout env vars' };
    }

    // 1. Check balance
    const balances = await nowpaymentsCaller.getBalance();
    if (!balances) throw new Error('Failed to fetch NowPayments balance');

    const usdcBalance = balances.find((b) => b.currency === 'usdcbase');
    const amount = usdcBalance ? parseFloat(usdcBalance.balance) : 0;

    if (amount <= SWEEP_THRESHOLD) {
      return { skipped: true, balance: amount, threshold: SWEEP_THRESHOLD };
    }

    const sweepAmount = Math.floor((amount - SWEEP_BUFFER) * 100) / 100; // Round down to 2 decimals

    // 2. Authenticate
    const token = await nowpaymentsCaller.authenticate();

    // 3. Create payout
    const payout = await nowpaymentsCaller.createPayout(
      {
        withdrawals: [
          {
            address: env.NOW_PAYMENTS_PAYOUT_ADDRESS,
            currency: 'usdcbase',
            amount: sweepAmount,
            ipn_callback_url: `${env.NEXTAUTH_URL}/api/webhooks/nowpayments-payout`,
          },
        ],
      },
      token
    );

    if (!payout) throw new Error('Failed to create payout');

    await logToAxiom({
      name: 'custody-sweep',
      type: 'info',
      message: 'Payout created',
      batchId: payout.id,
      amount: sweepAmount,
      balance: amount,
    }).catch();

    return {
      batchId: payout.id,
      amount: sweepAmount,
      remainingBalance: amount - sweepAmount,
    };
  },
  { shouldWait: false, lockExpiration: 300 }
);
