/**
 * Debug endpoint for Gift Memberships (GREEN / Stripe).
 * =============================================================================
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN via `?token=` query
 * param. Lets you exercise the full gift lifecycle without paying — fulfill
 * and revoke talk to the configured (test-mode in dev) Stripe account for
 * real coupons/subscriptions.
 *
 * Usage:
 *   POST /api/testing/gift-membership?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "action": "<action>", ...params }
 *
 * Actions (see the switch below for authoritative param list):
 *   dump         - {userId}                                        Gift rows (sent/received) + green subscription snapshot
 *   giftability  - {userId}                                        What getRecipientGiftability returns for the user
 *   create-gift  - {gifterId, recipientId, tier, months,           Insert a Pending MembershipGift row with a debug
 *                   message?, anonymous?}                          payment-intent id (skips Stripe Checkout)
 *   fulfill      - {giftId}                                        Run fulfillMembershipGift (real Stripe coupon/sub)
 *   revoke       - {giftId, reason?}                               Run revokeMembershipGift as if the payment was refunded
 *   reset        - {userId, confirm: true}                         Delete all MembershipGift rows where the user is
 *                                                                  gifter or recipient (does NOT touch Stripe)
 *
 * Flow: create-gift -> fulfill -> check /user/membership -> revoke -> reset.
 *
 * Permanent changes are scoped to a single user or gift per call so a misuse
 * never cascades across the DB.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  fulfillMembershipGift,
  getRecipientGiftability,
  revokeMembershipGift,
} from '~/server/services/membership-gift.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { MembershipGiftStatus } from '~/shared/utils/prisma/enums';

const actionSchema = z.enum(['dump', 'giftability', 'create-gift', 'fulfill', 'revoke', 'reset']);

const schema = z
  .object({
    action: actionSchema,
    userId: z.coerce.number().int().positive().optional(),
    gifterId: z.coerce.number().int().positive().optional(),
    recipientId: z.coerce.number().int().positive().optional(),
    tier: z.enum(['bronze', 'silver', 'gold']).optional(),
    months: z.coerce.number().int().positive().optional(),
    message: z.string().max(500).optional(),
    anonymous: z.coerce.boolean().optional(),
    giftId: z.string().optional(),
    reason: z.enum(['refund', 'chargeback']).optional(),
    confirm: z.coerce.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (['dump', 'giftability', 'reset'].includes(data.action) && !data.userId) {
      ctx.addIssue({ code: 'custom', message: `${data.action} requires userId`, path: ['userId'] });
    }
    if (
      data.action === 'create-gift' &&
      (!data.gifterId || !data.recipientId || !data.tier || !data.months)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'create-gift requires gifterId + recipientId + tier + months',
      });
    }
    if (['fulfill', 'revoke'].includes(data.action) && !data.giftId) {
      ctx.addIssue({ code: 'custom', message: `${data.action} requires giftId`, path: ['giftId'] });
    }
    if (data.action === 'reset' && !data.confirm) {
      ctx.addIssue({ code: 'custom', message: 'reset requires confirm=true' });
    }
  });

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const payload = schema.safeParse({ ...req.query, ...(req.body ?? {}) });
  if (!payload.success) {
    return res.status(400).json({ error: 'Invalid request', issues: payload.error.issues });
  }
  const input = payload.data;

  switch (input.action) {
    case 'dump': {
      const userId = input.userId!;
      const [sent, received, subscription] = await Promise.all([
        dbRead.membershipGift.findMany({
          where: { gifterId: userId },
          orderBy: { createdAt: 'desc' },
          take: 25,
        }),
        dbRead.membershipGift.findMany({
          where: { recipientId: userId },
          orderBy: { createdAt: 'desc' },
          take: 25,
        }),
        dbRead.customerSubscription.findUnique({
          where: { userId_buzzType: { userId, buzzType: 'green' } },
          include: { product: { select: { id: true, metadata: true, provider: true } } },
        }),
      ]);
      return res.status(200).json({ userId, sent, received, greenSubscription: subscription });
    }

    case 'giftability': {
      const result = await getRecipientGiftability({ recipientUserId: input.userId! });
      return res.status(200).json({ action: input.action, result });
    }

    case 'create-gift': {
      const gift = await dbWrite.membershipGift.create({
        data: {
          gifterId: input.gifterId!,
          recipientId: input.recipientId!,
          tier: input.tier!,
          months: input.months!,
          amountCents: 0,
          message: input.message,
          anonymous: input.anonymous ?? false,
          stripePaymentIntentId: `debug-pi:${Date.now()}`,
        },
      });
      return res.status(200).json({ action: input.action, gift });
    }

    case 'fulfill': {
      const result = await fulfillMembershipGift({ giftId: input.giftId! });
      return res.status(200).json({ action: input.action, ...result });
    }

    case 'revoke': {
      const gift = await dbWrite.membershipGift.findUnique({
        where: { id: input.giftId! },
        select: { stripePaymentIntentId: true },
      });
      if (!gift?.stripePaymentIntentId) {
        return res.status(404).json({ error: 'Gift not found or has no payment intent id' });
      }
      const result = await revokeMembershipGift({
        paymentIntentId: gift.stripePaymentIntentId,
        reason: input.reason ?? 'refund',
      });
      return res.status(200).json({ action: input.action, revoked: result });
    }

    case 'reset': {
      const userId = input.userId!;
      const pendingOrDone = await dbWrite.membershipGift.deleteMany({
        where: { OR: [{ gifterId: userId }, { recipientId: userId }] },
      });
      return res.status(200).json({
        action: input.action,
        deletedGifts: pendingOrDone.count,
        note: `Stripe coupons/subscriptions are untouched — revoke ${MembershipGiftStatus.Fulfilled} gifts first if needed.`,
      });
    }
  }

  return res.status(400).json({ error: 'Unhandled action' });
});
