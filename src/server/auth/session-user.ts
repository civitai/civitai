import type { SessionUser } from '~/types/session';
import { dbWrite } from '~/server/db/client';
import { sessionClient } from './session-client';

// Resolve the rich SessionUser by userId (or by API-key token → userId). The hub is the SOLE PRODUCER of
// session data (docs/thin-session-token-design.md, "LOCKED ARCHITECTURE"): we no longer compute it from the
// DB here. We read the shared `session:data2` cache and, on a miss, fetch the hub via
// `createSessionClient.getSessionUserById` (single-flight + read-through). The only DB touch left is the
// API-key → userId lookup for the bearer path.
//
// Date caveat: a cold hub miss returns dates as ISO strings (HTTP JSON); a warm cache hit returns real Dates.
// Coerce if a consumer needs a `Date`.
export const getSessionUser = async ({
  userId,
  token,
}: {
  userId?: number;
  token?: string;
}): Promise<SessionUser | undefined> => {
  if (!userId && !token) return undefined;

  // API-key token → userId (the bearer path's own resolver is in bearer-token.ts; this covers direct callers).
  if (!userId && token) {
    const now = new Date();
    const result = await dbWrite.apiKey.findFirst({
      where: { key: token, OR: [{ expiresAt: { gte: now } }, { expiresAt: null }] },
      select: { userId: true },
    });
    if (!result) return undefined;
    userId = result.userId;
  }
  if (!userId) return undefined;

  // The hub produces + caches; we only read. Structurally the ExtendedUser the app expects (kept in parity by
  // the hub's session-shape.ts), but loosely typed in the package contract — cast at this boundary.
  const user = await sessionClient.getSessionUserById(userId);
  return (user as unknown as SessionUser) ?? undefined;
};
