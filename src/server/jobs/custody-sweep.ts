import { createJob } from './job';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { redis } from '~/server/redis/client';

const SWEEP_THRESHOLD = 5; // Only sweep if balance > $5
const SWEEP_BUFFER = 1; // Leave $1 in custody
/** Prevent duplicate sweeps within this window (seconds) */
const SWEEP_DEDUP_TTL = 3600; // 1 hour
// 🔴 DELIBERATELY NOT ENVIRONMENT-NAMESPACED (unlike every other on-the-fly redis key — see
// packages/civitai-redis/src/cache-key-prefix.ts). This is not a cache entry; it is the mutual
// exclusion guard around a REAL payout, and the payout is made against the payment provider by
// API credentials, not against a database. Every environment that holds those credentials can
// therefore move real money. Sharing this one key across environments is PROTECTIVE: it means a
// non-production deployment that runs this job is suppressed by production's recent sweep instead
// of issuing a second one. Namespacing it would give each environment an independent key and
// remove that suppression — a strictly worse failure than the cache co-tenancy the namespace
// exists to fix. Read and write are both unprefixed, so this is self-consistent.
const SWEEP_DEDUP_KEY = 'custody-sweep:last-payout' as RedisKeyTemplateCache;

export const custodySweepJob = createJob(
  'custody-sweep',
  '0 4 * * *', // Daily at 04:00 UTC
  async () => {
    if (!env.NOW_PAYMENTS_EMAIL || !env.NOW_PAYMENTS_PASSWORD || !env.NOW_PAYMENTS_PAYOUT_ADDRESS) {
      return { skipped: true, reason: 'Missing payout env vars' };
    }

    // Dedup guard: if a payout was already created recently, skip
    const lastPayout = await redis.get(SWEEP_DEDUP_KEY);
    if (lastPayout) {
      return { skipped: true, reason: 'Payout already created recently', lastPayout };
    }

    // 1. Check balance
    const balances = await nowpaymentsCaller.getBalance();
    if (!balances) throw new Error('Failed to fetch NowPayments balance');

    const usdcBalance = balances.find((b) => b.currency === 'usdcbase');
    const amount = usdcBalance ? parseFloat(usdcBalance.balance) : 0;

    if (isNaN(amount) || amount <= 0) {
      throw new Error(`Invalid balance value: ${usdcBalance?.balance ?? 'not found'}`);
    }

    if (amount <= SWEEP_THRESHOLD) {
      return { skipped: true, balance: amount, threshold: SWEEP_THRESHOLD };
    }

    const sweepAmount = Math.floor((amount - SWEEP_BUFFER) * 100) / 100; // Round down to 2 decimals
    if (sweepAmount <= 0) {
      return { skipped: true, balance: amount, reason: 'Sweep amount too small after buffer' };
    }

    // 2. Set dedup key BEFORE creating payout to prevent concurrent runs
    await redis.set(SWEEP_DEDUP_KEY, new Date().toISOString(), { EX: SWEEP_DEDUP_TTL });

    try {
      // 3. Authenticate
      const token = await nowpaymentsCaller.authenticate();

      // 4. Create payout
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

      if (!payout) {
        // Clear dedup key so the next run can retry
        await redis.del(SWEEP_DEDUP_KEY);
        throw new Error('Failed to create payout');
      }

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
    } catch (error) {
      // Clear dedup key on failure so next run can retry
      await redis.del(SWEEP_DEDUP_KEY).catch(() => null);
      throw error;
    }
  },
  { shouldWait: false, lockExpiration: 300 }
);
