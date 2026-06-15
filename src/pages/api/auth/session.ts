import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { USE_HUB_SESSION } from '~/server/auth/session-client';
// STEP-H-REMOVAL: drop this import + the `!USE_HUB_SESSION` delegation block below. Once the hub is the
// sole issuer the off-branch is dead; this route becomes "return the hub session" unconditionally.
import nextAuthHandler from './[...nextauth]';

// Specific route shadowing the [...nextauth] catch-all for EXACTLY /api/auth/session (a concrete file
// wins over the catch-all for that path). next-auth/react's SessionProvider + useSession (and thus the
// 317 useCurrentUser sites) poll this endpoint.
//
// When the thin-session flag is ON, return the hub-resolved session — HYBRID via getServerAuthSession:
// hub civ-token first, else the legacy next-auth cookie — in next-auth's `{ user, expires }` shape, so
// the client half flips with zero call-site changes. When OFF, delegate to next-auth's own session
// action (unchanged behavior). See docs/main-app-auth-cutover.md.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // STEP-H-REMOVAL: delete this entire off-branch (the only consumer of nextAuthHandler here).
  if (!USE_HUB_SESSION) {
    // Delegate to next-auth's session handler — fake the catch-all route param it dispatches on.
    req.query.nextauth = ['session'];
    return nextAuthHandler(req, res);
  }

  const session = await getServerAuthSession({ req, res });
  if (!session?.user) {
    // next-auth convention: an empty object (200), not 401, means "no active session".
    return res.status(200).json({});
  }

  // next-auth's Session type requires `expires`. The legacy fallback path already carries it; the thin
  // hub session does not surface it client-side, so synthesize a far-future value. The cookie's real
  // maxAge + the hub's revocation markers govern the actual lifetime — this is only the client's refetch hint.
  const expires =
    (session as { expires?: string }).expires ??
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return res.status(200).json({ ...session, expires });
}
