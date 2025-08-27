import type { AxiomAPIRequest } from '@civitai/next-axiom';
import type { NextApiResponse } from 'next';
import * as z from 'zod';
import dayjs from '~/shared/utils/dayjs';
import { dbWrite } from '~/server/db/client';
import {
  createRedeemableCodes,
  consumeRedeemableCode,
} from '~/server/services/redeemableCode.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { PaymentProvider, RedeemableCodeType } from '~/shared/utils/prisma/enums';

const grantSubscriptionSchema = z.object({
  userId: z.coerce.number(),
  period: z.enum(['month', 'year']),
  unitValue: z.coerce.number().default(1),
  tier: z.enum(['bronze', 'silver', 'gold']),
});

export default WebhookEndpoint(async function (req: AxiomAPIRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed. Use POST.');

  try {
    const input = grantSubscriptionSchema.parse(req.body);
    const { userId, period, unitValue, tier } = input;

    // Check if user has an active subscription
    const existingSubscription = await dbWrite.customerSubscription.findFirst({
      where: { userId },
      include: {
        product: {
          select: { metadata: true, provider: true },
        },
      },
    });

    if (existingSubscription) {
      // If subscription is active, return early
      if (
        existingSubscription.status === 'active' &&
        existingSubscription.currentPeriodEnd > new Date()
      ) {
        return res.status(200).json({
          message: 'User already has an active subscription',
          subscription: existingSubscription,
        });
      }

      // If subscription exists but is cancelled/expired, we'll update it
      // But first we need to find the right product/price for the requested tier
    }

    // Find the product and price for the requested tier and period
    const product = await dbWrite.product.findFirst({
      where: {
        active: true,
        provider: PaymentProvider.Civitai,
        metadata: {
          path: ['tier'],
          equals: tier,
        },
      },
      include: {
        prices: {
          where: {
            active: true,
            interval: period,
          },
        },
      },
    });

    if (!product || product.prices.length === 0) {
      return res.status(400).json({
        error: `No active product found for tier: ${tier} with interval: ${period}`,
      });
    }

    const price = product.prices[0];

    if (existingSubscription && existingSubscription.status !== 'active') {
      // Update existing cancelled subscription
      const now = dayjs();
      await dbWrite.customerSubscription.update({
        where: { id: existingSubscription.id },
        data: {
          productId: product.id,
          priceId: price.id,
          status: 'active',
          currentPeriodStart: now.toDate(),
          currentPeriodEnd: now.add(unitValue, period).toDate(),
          cancelAtPeriodEnd: true,
          cancelAt: null,
          metadata: {},
        },
      });

      return res.status(200).json({
        message: 'Subscription updated successfully',
        subscription: existingSubscription,
      });
    }

    // Create a redeemable code and consume it for new subscription
    const codes = await createRedeemableCodes({
      unitValue,
      type: RedeemableCodeType.Membership,
      quantity: 1,
      priceId: price.id,
    });

    const code = codes[0];

    // Consume the code immediately
    const consumedCode = await consumeRedeemableCode({
      code,
      userId,
    });

    return res.status(200).json({
      message: 'Subscription granted successfully',
      code: consumedCode,
    });
  } catch (error) {
    console.error('Error granting subscription:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});
