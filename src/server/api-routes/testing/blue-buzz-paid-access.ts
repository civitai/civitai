/**
 * Debug endpoint for Blue Buzz paid access.
 * =============================================================================
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN via `?token=` query param.
 *
 * Exists because the one property the feature turns on — a blue purchase credits the OWNER's blue
 * account, never a bankable one — cannot be proven by unit tests, which mock the Buzz ledger. This
 * drives a real purchase through the real ledger and reads both sides' balances back.
 *
 * Usage:
 *   POST /api/testing/blue-buzz-paid-access?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "action": "<action>", ...params }
 *
 * Actions (see the switch below for the authoritative param list):
 *   dump          - {modelVersionId, buyerId?}                  Gate terms, opt-in flag, both parties' balances
 *   set-gate      - {modelVersionId, price?, acceptsBlueBuzz?}  Put a permanent gate on a version
 *   clear-gate    - {modelVersionId}                            Remove the gate
 *   grant-blue    - {userId, amount}                            Mint blue into a test buyer's account
 *   purchase      - {modelVersionId, buyerId, payWithBlue?, type?}
 *                                                               Real charge via earlyAccessPurchase
 *   revoke-access - {modelVersionId, buyerId}                   Drop the EntityAccess grant so you can re-buy
 *
 * Flow to verify the invariant end to end:
 *   set-gate (acceptsBlueBuzz=true) -> grant-blue (buyerId) -> dump -> purchase (payWithBlue=true)
 *   -> dump, and confirm the OWNER's blue balance rose by the price while yellow/green did not.
 *
 * Every action is scoped to one modelVersionId and/or one userId per call, so a misuse cannot
 * cascade. `purchase` moves REAL Buzz on whatever environment it is pointed at.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { acceptsBlueBuzz as termsAcceptBlue, type ModelVersionTerms } from '@civitai/buzz';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  createBuzzTransaction,
  getUserBuzzAccountByAccountTypes,
} from '~/server/services/buzz.service';
import { earlyAccessPurchase } from '~/server/services/model-version.service';
import {
  getPaidAccess,
  writePaidAccessForModelVersion,
} from '~/server/services/paid-access.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const actionSchema = z.enum([
  'dump',
  'set-gate',
  'clear-gate',
  'grant-blue',
  'purchase',
  'revoke-access',
]);

// NOT z.coerce.boolean(), which maps every non-empty string to true — `"payWithBlue": "false"` would
// spend blue. On an endpoint that moves real Buzz the string forms have to be read, not truthy-cast.
const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1')
  .optional();

const schema = z
  .object({
    action: actionSchema,
    modelVersionId: z.coerce.number().int().positive().optional(),
    buyerId: z.coerce.number().int().positive().optional(),
    userId: z.coerce.number().int().positive().optional(),
    price: z.coerce.number().int().positive().optional(),
    amount: z.coerce.number().int().positive().optional(),
    acceptsBlueBuzz: boolish,
    payWithBlue: boolish,
    type: z.enum(['download', 'generation']).optional(),
  })
  .superRefine((data, ctx) => {
    const needsVersion: z.infer<typeof actionSchema>[] = [
      'dump',
      'set-gate',
      'clear-gate',
      'purchase',
      'revoke-access',
    ];
    if (needsVersion.includes(data.action) && !data.modelVersionId) {
      ctx.addIssue({
        code: 'custom',
        message: `${data.action} requires modelVersionId`,
        path: ['modelVersionId'],
      });
    }
    if (['purchase', 'revoke-access'].includes(data.action) && !data.buyerId) {
      ctx.addIssue({
        code: 'custom',
        message: `${data.action} requires buyerId`,
        path: ['buyerId'],
      });
    }
    if (data.action === 'grant-blue' && (!data.userId || !data.amount)) {
      ctx.addIssue({ code: 'custom', message: 'grant-blue requires userId + amount' });
    }
  });

const SPEND_TYPES = ['blue', 'green', 'yellow'] as const;

const balances = async (accountId: number) =>
  getUserBuzzAccountByAccountTypes(accountId, [...SPEND_TYPES]);

const ownerOf = async (modelVersionId: number) => {
  const version = await dbRead.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: { id: true, name: true, status: true, model: { select: { id: true, userId: true } } },
  });
  if (!version) throw new Error(`Model version ${modelVersionId} not found`);
  return version;
};

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: z.treeifyError(parsed.error) });
  const input = parsed.data;

  try {
    switch (input.action) {
      case 'dump': {
        const modelVersionId = input.modelVersionId as number;
        const version = await ownerOf(modelVersionId);
        const gate = (await getPaidAccess('ModelVersion', [modelVersionId]))[modelVersionId];
        const terms = gate?.terms as ModelVersionTerms | undefined;
        return res.status(200).json({
          action: input.action,
          modelVersionId,
          versionStatus: version.status,
          ownerId: version.model.userId,
          gate: gate ? { endsAt: gate.endsAt, timeframeDays: gate.timeframeDays, terms } : null,
          acceptsBlueBuzz: termsAcceptBlue(terms),
          ownerBalances: await balances(version.model.userId),
          buyerBalances: input.buyerId ? await balances(input.buyerId) : undefined,
        });
      }

      case 'set-gate': {
        const modelVersionId = input.modelVersionId as number;
        const version = await ownerOf(modelVersionId);
        const price = input.price ?? 500;
        await writePaidAccessForModelVersion(modelVersionId, {
          permanent: true,
          terms: {
            download: { price },
            generation: { price, trialLimit: 0 },
            ...(input.acceptsBlueBuzz ? { acceptsBlueBuzz: true } : {}),
          },
        });
        return res.status(200).json({
          action: input.action,
          modelVersionId,
          ownerId: version.model.userId,
          price,
          acceptsBlueBuzz: !!input.acceptsBlueBuzz,
        });
      }

      case 'clear-gate': {
        const modelVersionId = input.modelVersionId as number;
        await writePaidAccessForModelVersion(modelVersionId, null);
        return res.status(200).json({ action: input.action, modelVersionId, cleared: true });
      }

      case 'grant-blue': {
        const userId = input.userId as number;
        const amount = input.amount as number;
        const transaction = await createBuzzTransaction({
          fromAccountId: 0, // bank
          toAccountId: userId,
          toAccountType: 'blue',
          amount,
          type: TransactionType.Reward,
          description: 'Blue Buzz paid-access debug grant',
          externalTransactionId: `debug-blue-grant-${userId}-${Date.now()}`,
        });
        return res.status(200).json({
          action: input.action,
          userId,
          amount,
          transactionId: transaction?.transactionId,
          balances: await balances(userId),
        });
      }

      case 'purchase': {
        const modelVersionId = input.modelVersionId as number;
        const buyerId = input.buyerId as number;
        const version = await ownerOf(modelVersionId);
        const ownerId = version.model.userId;
        const before = { owner: await balances(ownerId), buyer: await balances(buyerId) };

        await earlyAccessPurchase({
          userId: buyerId,
          modelVersionId,
          type: input.type ?? 'download',
          buzzType: input.payWithBlue ? 'blue' : 'yellow',
        });

        const after = { owner: await balances(ownerId), buyer: await balances(buyerId) };
        const delta = (kind: 'owner' | 'buyer') =>
          Object.fromEntries(
            SPEND_TYPES.map((t) => [t, (after[kind][t] ?? 0) - (before[kind][t] ?? 0)])
          );
        return res.status(200).json({
          action: input.action,
          modelVersionId,
          ownerId,
          buyerId,
          paidWith: input.payWithBlue ? 'blue' : 'yellow',
          before,
          after,
          // The assertion to eyeball: a blue purchase must show blue-only movement on BOTH sides.
          ownerDelta: delta('owner'),
          buyerDelta: delta('buyer'),
        });
      }

      case 'revoke-access': {
        const modelVersionId = input.modelVersionId as number;
        const buyerId = input.buyerId as number;
        const deleted = await dbWrite.entityAccess.deleteMany({
          where: {
            accessToId: modelVersionId,
            accessToType: 'ModelVersion',
            accessorId: buyerId,
            accessorType: 'User',
          },
        });
        return res
          .status(200)
          .json({ action: input.action, modelVersionId, buyerId, deleted: deleted.count });
      }
    }
  } catch (error) {
    return res.status(500).json({ action: input.action, error: (error as Error).message });
  }

  return res.status(400).json({ error: 'Unhandled action' });
});
