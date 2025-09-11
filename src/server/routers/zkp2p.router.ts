import { z } from 'zod';
import { env } from '~/env/server';
import { protectedProcedure, router } from '~/server/trpc';

export const zkp2pRouter = router({
  checkUSDCAvailability: protectedProcedure.query(async ({ ctx }) => {
    try {
      const zkp2pHost = env.NEXT_PUBLIC_ZKP2P_IFRAME_HOST;
      const adminToken = env.WEBHOOK_TOKEN;

      if (!zkp2pHost || !adminToken) {
        return { shouldShow: false, balance: 0 };
      }

      const response = await fetch(`${zkp2pHost}/api/external/usdc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: ctx.user.id,
          action: 'check',
          adminToken: adminToken,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const balance = data.usdcBalance || 0;
        return {
          shouldShow: balance > 0,
          balance: balance,
        };
      } else {
        return { shouldShow: false, balance: 0 };
      }
    } catch (error) {
      console.error('Error checking USDC availability:', error);
      return { shouldShow: false, balance: 0 };
    }
  }),

  processUSDCPurchase: protectedProcedure
    .input(
      z.object({
        amount: z.number().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const zkp2pHost = env.NEXT_PUBLIC_ZKP2P_IFRAME_HOST;
        const adminToken = env.WEBHOOK_TOKEN;

        if (!zkp2pHost || !adminToken) {
          throw new Error('ZKP2P host or admin token not configured');
        }

        const response = await fetch(`${zkp2pHost}/api/external/usdc`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            userId: ctx.user.id,
            action: 'complete',
            adminToken: adminToken,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          return {
            success: true,
            usdcSwept: data.usdcSwept,
            buzzAmount: data.buzzAmount,
            baseBuzzAmount: data.baseBuzzAmount,
            multiplier: data.multiplier,
            message: data.message,
          };
        } else {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || 'Failed to process USDC purchase');
        }
      } catch (error) {
        console.error('Error processing USDC purchase:', error);
        throw new Error('Failed to process USDC purchase');
      }
    }),
});
