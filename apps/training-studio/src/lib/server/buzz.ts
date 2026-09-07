import { createBuzzClient, type BuzzClient } from '@civitai/buzz';
import { env } from '$env/dynamic/private';

// Server-side buzz-service client — reads the user's balance for the header directly (no browser
// cross-origin call, so no CORS). Same pattern as the moderator app. Lazy: a missing BUZZ_ENDPOINT
// throws on first use, not at boot.
let client: BuzzClient | undefined;

export function getBuzz(): BuzzClient {
  if (!client) client = createBuzzClient({ endpoint: env.BUZZ_ENDPOINT });
  return client;
}

/** The user's spendable buzz for the header pill: yellow (purchased) + blue (generation). `total` sums the
 *  service's response directly (robust to its account-key casing, since only these two types are asked
 *  for); yellow/blue are best-effort for the tooltip. Returns null on any failure so a buzz-service blip
 *  never breaks the page — the header just omits the balance. */
export async function getSpendableBuzz(
  userId: number
): Promise<{ total: number; yellow: number; blue: number } | null> {
  try {
    const accounts = await getBuzz().getUserAccounts(userId, ['yellow', 'blue']);
    const total = Object.values(accounts).reduce(
      (sum, v) => sum + (typeof v === 'number' ? v : 0),
      0
    );
    const yellow = accounts['User'] ?? accounts['user'] ?? accounts['yellow'] ?? 0;
    const blue = accounts['Generation'] ?? accounts['generation'] ?? accounts['blue'] ?? 0;
    return { total, yellow, blue };
  } catch {
    return null;
  }
}
