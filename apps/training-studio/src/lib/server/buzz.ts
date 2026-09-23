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

/** The user's spendable buzz per account — yellow (purchased), green (membership), blue (generation) — for
 *  the header. Best-effort key mapping (the service keys by API type); returns null on any failure so a
 *  buzz-service blip never breaks the page — the header just omits the balance. */
export async function getSpendableBuzz(
  userId: number
): Promise<{ yellow: number; green: number; blue: number } | null> {
  try {
    const accounts = await getBuzz().getUserAccounts(userId, ['yellow', 'green', 'blue']);
    const yellow = accounts['User'] ?? accounts['user'] ?? accounts['yellow'] ?? 0;
    const green = accounts['Green'] ?? accounts['green'] ?? 0;
    const blue = accounts['Generation'] ?? accounts['generation'] ?? accounts['blue'] ?? 0;
    return { yellow, green, blue };
  } catch {
    return null;
  }
}
