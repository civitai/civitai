import crypto from 'crypto';
import { z } from 'zod';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { merchClaimConfirmationEmail, merchClaimInviteEmail } from '~/server/email/templates';
import { logToAxiom } from '~/server/logging/client';
import { redis } from '~/server/redis/client';
import { setCustomerCivitaiUserId } from '~/server/http/shopify/shopify.caller';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { computeMerchBuzz } from '~/server/utils/merch-buzz';

const log = (data: MixedObject) =>
  logToAxiom({ name: 'shopify-merch', type: 'error', ...data }).catch(() => null);

// Subset of the Shopify `orders/paid` payload we depend on. Shopify sends prices
// as decimal strings and customer/discounts may be absent on some orders.
export const shopifyOrderPaidSchema = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  email: z.string().email().nullish(),
  current_subtotal_price: z.coerce.number().nullish(),
  subtotal_price: z.coerce.number().nullish(),
  customer: z
    .object({
      id: z.union([z.number(), z.string()]).transform(String).nullish(),
      email: z.string().email().nullish(),
    })
    .nullish(),
  discount_codes: z.array(z.object({ code: z.string() })).nullish(),
});
export type ShopifyOrderPaid = z.infer<typeof shopifyOrderPaidSchema>;

// --- claim confirmation token (signed server-side; emailed to the order's address) ---

const CLAIM_TOKEN_TTL_MS = 1000 * 60 * 60 * 24; // 24h

function b64url(buf: Buffer) {
  return buf.toString('base64url');
}

function signClaimToken(shopifyOrderId: string, userId: number) {
  const exp = Date.now() + CLAIM_TOKEN_TTL_MS;
  const payload = b64url(Buffer.from(JSON.stringify({ o: shopifyOrderId, u: userId, exp })));
  const sig = b64url(crypto.createHmac('sha256', env.NEXTAUTH_SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifyClaimToken(token: string): { shopifyOrderId: string; userId: number } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = b64url(
    crypto.createHmac('sha256', env.NEXTAUTH_SECRET).update(payload).digest()
  );
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  )
    return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return { shopifyOrderId: String(data.o), userId: Number(data.u) };
  } catch {
    return null;
  }
}

function maskEmail(email: string) {
  const [name, domain] = email.split('@');
  if (!domain) return '***';
  const visible = name.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(name.length - 1, 2))}@${domain}`;
}

// Per-user attempt cap to defeat order-id enumeration / confirmation-email grinding.
const CLAIM_RATE_WINDOW_SECONDS = 600; // 10 min
const CLAIM_RATE_MAX = 20;
async function withinClaimRateLimit(userId: number) {
  const key = `merch:claim-rate:${userId}`;
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) await redis.expire(key as never, CLAIM_RATE_WINDOW_SECONDS);
    return count <= CLAIM_RATE_MAX;
  } catch {
    return true; // fail open — never block legit claims on a Redis incident
  }
}

async function getVerifiedUserEmail(userId: number) {
  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  return { email: user?.email?.toLowerCase() ?? null, verified: !!user?.emailVerified };
}

async function grantMerchBuzz({
  userId,
  shopifyOrderId,
  amount,
  details,
}: {
  userId: number;
  shopifyOrderId: string;
  amount: number;
  details: MixedObject;
}) {
  if (amount <= 0) return;
  // Idempotent on the Shopify order id — Shopify retries webhooks, and a later
  // claim can re-trigger a grant for the same order; the buzz API dedupes on
  // externalTransactionId so this is safe to call more than once.
  await createBuzzTransaction({
    type: TransactionType.Reward,
    fromAccountId: 0, // central bank
    toAccountId: userId,
    toAccountType: 'blue',
    amount,
    externalTransactionId: `merchPurchase:${shopifyOrderId}`,
    description: 'Blue Buzz reward for merch purchase',
    details: { type: 'merchPurchase', shopifyOrderId, ...details },
  });
}

/**
 * Persist the Shopify customer → Civitai user link, then back-pay every pending
 * order for that customer (or email, if the order has no customer id). Used by
 * both the email-match and email-confirmation claim paths.
 */
async function linkAndGrantPending(
  userId: number,
  order: { shopifyCustomerId: string | null; email: string }
) {
  if (order.shopifyCustomerId) {
    await dbWrite.shopifyCustomerLink.upsert({
      where: { shopifyCustomerId: order.shopifyCustomerId },
      create: { shopifyCustomerId: order.shopifyCustomerId, email: order.email, userId },
      update: { email: order.email, userId },
    });
    // Stamp the link onto the Shopify customer so the order page stops showing
    // the claim prompt for them. Best-effort — never blocks the grant.
    await setCustomerCivitaiUserId(order.shopifyCustomerId, userId);
  }

  const pending = await dbWrite.shopifyMerchOrder.findMany({
    where: {
      status: 'Pending',
      ...(order.shopifyCustomerId
        ? { shopifyCustomerId: order.shopifyCustomerId }
        : { email: order.email }),
    },
  });

  let granted = 0;
  for (const o of pending) {
    try {
      await grantMerchBuzz({
        userId,
        shopifyOrderId: o.shopifyOrderId,
        amount: o.buzzAmount,
        details: { couponCodes: o.couponCodes, subtotal: Number(o.subtotal) },
      });
      await dbWrite.shopifyMerchOrder.update({
        where: { shopifyOrderId: o.shopifyOrderId },
        data: { status: 'Granted', userId, grantedAt: new Date() },
      });
      granted += o.buzzAmount;
    } catch (error) {
      log({
        message: 'Failed to grant claimed merch order',
        shopifyOrderId: o.shopifyOrderId,
        error,
      });
    }
  }
  return { claimedOrders: pending.length, grantedBuzz: granted };
}

/**
 * Handle a Shopify `orders/paid` webhook: record the order and, if we already
 * know which Civitai user this customer is, grant Blue Buzz immediately.
 * Otherwise the order stays Pending until the user claims it.
 */
export async function processShopifyOrderPaid(order: ShopifyOrderPaid) {
  const shopifyOrderId = order.id;
  const email = (order.customer?.email ?? order.email ?? '').toLowerCase();
  const shopifyCustomerId = order.customer?.id ?? null;
  const subtotal = order.current_subtotal_price ?? order.subtotal_price ?? 0;
  const couponCodes = (order.discount_codes ?? []).map((d) => d.code);
  const buzzAmount = computeMerchBuzz(subtotal, couponCodes);

  // Track whether this is the first time we see the order so a webhook retry
  // (Shopify redelivers) doesn't re-send the claim invite email.
  const existing = await dbWrite.shopifyMerchOrder.findUnique({
    where: { shopifyOrderId },
    select: { shopifyOrderId: true },
  });

  const link = await dbWrite.shopifyCustomerLink.findFirst({
    where: shopifyCustomerId ? { shopifyCustomerId } : { email },
    select: { userId: true },
  });
  const userId = link?.userId ?? null;

  await dbWrite.shopifyMerchOrder.upsert({
    where: { shopifyOrderId },
    create: {
      shopifyOrderId,
      email,
      shopifyCustomerId,
      subtotal,
      couponCodes,
      buzzAmount,
      userId,
      status: userId ? 'Granted' : 'Pending',
      grantedAt: userId ? new Date() : null,
    },
    // Only touch identity/amount fields on replay; never downgrade a Granted order.
    update: { email, shopifyCustomerId, subtotal, couponCodes, buzzAmount },
  });

  if (userId) {
    await grantMerchBuzz({
      userId,
      shopifyOrderId,
      amount: buzzAmount,
      details: { couponCodes, subtotal },
    });
  } else if (!existing && buzzAmount > 0 && email) {
    // First time seeing an unlinked order — invite the buyer to claim. Once they
    // claim, the customer is linked and future orders auto-grant (no email).
    try {
      await merchClaimInviteEmail.send({
        to: email,
        buzzAmount,
        claimUrl: `${getBaseUrl()}/merch/claim?order=${shopifyOrderId}`,
      });
    } catch (error) {
      log({ message: 'Failed to send merch claim invite', shopifyOrderId, error });
    }
  }

  return { shopifyOrderId, buzzAmount, userId, status: userId ? 'Granted' : 'Pending' };
}

/** Order summary for the claim page: amount, whether the logged-in user's email already matches. */
export async function getClaimableMerchOrder({
  shopifyOrderId,
  userId,
}: {
  shopifyOrderId: string;
  userId: number;
}) {
  const order = await dbWrite.shopifyMerchOrder.findUnique({ where: { shopifyOrderId } });
  if (!order) return { found: false as const };
  if (order.status === 'Granted')
    return { found: true as const, alreadyClaimed: true, buzzAmount: order.buzzAmount };

  const { email, verified } = await getVerifiedUserEmail(userId);
  const emailMatches = verified && !!email && email === order.email.toLowerCase();
  return {
    found: true as const,
    alreadyClaimed: false,
    buzzAmount: order.buzzAmount,
    emailMatches,
    maskedEmail: maskEmail(order.email),
  };
}

/**
 * Claim by order id. If the logged-in user's verified email matches the order,
 * grant immediately. Otherwise tell the caller a confirmation email is required.
 */
export async function claimMerchOrder({
  userId,
  shopifyOrderId,
}: {
  userId: number;
  shopifyOrderId: string;
}) {
  if (!(await withinClaimRateLimit(userId)))
    throw new Error('Too many claim attempts. Please try again later.');

  const order = await dbWrite.shopifyMerchOrder.findUnique({ where: { shopifyOrderId } });
  if (!order) throw new Error('Order not found. It may not have been paid yet.');
  if (order.status === 'Granted') return { status: 'already_claimed' as const, grantedBuzz: 0 };

  const { email, verified } = await getVerifiedUserEmail(userId);
  if (verified && email && email === order.email.toLowerCase()) {
    const { grantedBuzz } = await linkAndGrantPending(userId, order);
    return { status: 'granted' as const, grantedBuzz };
  }

  return { status: 'needs_confirmation' as const, maskedEmail: maskEmail(order.email) };
}

/**
 * Email-mismatch path: the user asserts the order's email. We only send a
 * confirmation link if it matches the email on file (so we never email a
 * stranger), and the link can only be acted on by whoever controls that mailbox.
 */
export async function requestMerchClaimConfirmation({
  userId,
  username,
  shopifyOrderId,
  providedEmail,
}: {
  userId: number;
  username: string;
  shopifyOrderId: string;
  providedEmail: string;
}) {
  if (!(await withinClaimRateLimit(userId)))
    throw new Error('Too many claim attempts. Please try again later.');

  const order = await dbWrite.shopifyMerchOrder.findUnique({ where: { shopifyOrderId } });
  if (!order) throw new Error('Order not found. It may not have been paid yet.');
  if (order.status === 'Granted') return { status: 'already_claimed' as const };

  // Generic failure — never reveal the email on file.
  if (providedEmail.trim().toLowerCase() !== order.email.toLowerCase())
    throw new Error("We couldn't verify that email against this order.");

  const token = signClaimToken(shopifyOrderId, userId);
  const confirmUrl = `${getBaseUrl()}/merch/claim?token=${encodeURIComponent(token)}`;
  await merchClaimConfirmationEmail.send({
    to: order.email,
    username,
    buzzAmount: order.buzzAmount,
    confirmUrl,
  });

  return { status: 'confirmation_sent' as const, maskedEmail: maskEmail(order.email) };
}

/** Act on a confirmation link. Token binds the order + the user who requested it. */
export async function confirmMerchClaim({ userId, token }: { userId: number; token: string }) {
  const decoded = verifyClaimToken(token);
  if (!decoded) throw new Error('This confirmation link is invalid or has expired.');
  if (decoded.userId !== userId)
    throw new Error('Please sign in to the Civitai account that started this claim.');

  const order = await dbWrite.shopifyMerchOrder.findUnique({
    where: { shopifyOrderId: decoded.shopifyOrderId },
  });
  if (!order) throw new Error('Order not found.');
  if (order.status === 'Granted') return { status: 'already_claimed' as const, grantedBuzz: 0 };

  const { grantedBuzz } = await linkAndGrantPending(userId, order);
  return { status: 'granted' as const, grantedBuzz };
}
