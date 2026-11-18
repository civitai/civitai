import { purchaseCanBeRetriedFresh } from '~/components/Sticker/sticker.util';
import { mintPurchaseKey } from '~/utils/purchase-key';

/**
 * One idempotency key per paid action the user is trying to complete, held for the browser
 * session. The server charges under an id derived from it, so resending the same action after an
 * unanswered request is deduplicated instead of charged again. Module state rather than component
 * state: closing a form while its request is unanswered and reopening it is the same action, and a
 * fresh key there would charge again.
 *
 * A key is released when the action ends: on success, or when the server declined (a 4xx other
 * than 408 and 429: nothing was charged). Any other failure may have charged, so the key is held
 * and the next attempt at the same action reuses it.
 *
 * The one hold/release rule for every keyed payment on the client, cosmetic shop purchases
 * included (`withPurchaseIntentKey`, intent `cosmetic:<shopItemId>`).
 */
const held = new Map<string, string>();
const mintedAt = new Map<string, number>();

export function paymentIntentKey(intent: string): string {
  const existing = held.get(intent);
  if (existing) return existing;
  const key = mintPurchaseKey();
  held.set(intent, key);
  mintedAt.set(key, Date.now());
  return key;
}

/**
 * When `key` was minted (epoch ms), the same on every retry under it: for a server that files the
 * charge under a time as well as the key (a bounty's creation charge carries its charge time).
 */
export function paymentIntentKeyMintedAt(key: string): number | undefined {
  return mintedAt.get(key);
}

/** Ends the action `key` was minted for, if it has: `error` absent is success. */
export function settlePaymentIntentKey(intent: string, key: string, error?: unknown) {
  if (error !== undefined && !purchaseCanBeRetriedFresh(error)) return;
  // Only the key this attempt used: a newer attempt may already hold the slot.
  if (held.get(intent) === key) {
    held.delete(intent);
    mintedAt.delete(key);
  }
}

/** Sends `send` under the intent's key and settles the key by the outcome. */
export async function withPaymentIntentKey<T>(
  intent: string,
  send: (idempotencyKey: string) => Promise<T>
): Promise<T> {
  const key = paymentIntentKey(intent);
  try {
    const result = await send(key);
    settlePaymentIntentKey(intent, key);
    return result;
  } catch (error) {
    settlePaymentIntentKey(intent, key, error);
    throw error;
  }
}

/**
 * The intent of an on-site tip: the same recipient, entity, amount and currency is the same tip,
 * so resending it after a failure that may have moved the Buzz reuses its key. Any difference is
 * a different tip.
 */
export function tipIntent(tip: {
  toAccountId?: number;
  entityType?: string;
  entityId?: number;
  amount: number;
  fromAccountType?: string;
}) {
  return `tip:${tip.toAccountId ?? ''}:${tip.entityType ?? ''}:${tip.entityId ?? ''}:${
    tip.amount
  }:${tip.fromAccountType ?? ''}`;
}

/**
 * The intent of a submission: its kind and everything it sends. Resending the same content is the
 * same submission and reuses its key; changing anything makes a new submission with a new key, so
 * a held key never carries one submission's charge onto another's content.
 */
export function submissionIntent(kind: string, content: Record<string, unknown>) {
  return `${kind}:${JSON.stringify(content)}`;
}
