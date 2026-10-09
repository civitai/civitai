type CryptoLike = Pick<Crypto, 'getRandomValues'> & { randomUUID?: () => string };

/**
 * A v4 UUID for a purchase idempotency key (the server requires one).
 *
 * `randomUUID` only exists in secure contexts, so plain-http origins fall back to
 * `getRandomValues`, which does not need one. Never a counter: a key has to stay
 * unique across reloads and tabs, and a counter restarts at 1, so a reused key is
 * answered from the earlier purchase it belonged to.
 */
export function mintPurchaseKey(source: CryptoLike = crypto): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID();

  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
