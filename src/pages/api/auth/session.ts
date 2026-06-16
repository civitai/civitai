import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';

// next-auth/react's SessionProvider + useSession (and the ~317 useCurrentUser sites) poll this endpoint. It
// shadows the old [...nextauth] catch-all for exactly /api/auth/session and returns the hub-resolved session
// (civ-token, or a legacy civitai-token via the jose decoder) in next-auth's `{ user, expires }` shape, so the
// client half is unchanged until the first-party provider replaces next-auth/react.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerAuthSession({ req, res });
  if (!session?.user) {
    // next-auth convention: an empty object (200), not 401, means "no active session".
    return res.status(200).json({});
  }

  // next-auth's Session type requires `expires`. The thin hub session doesn't surface it client-side, so
  // synthesize a far-future value — the cookie's real maxAge + the hub's revocation markers govern lifetime.
  const expires =
    (session as { expires?: string }).expires ??
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return res.status(200).json({ ...session, expires });
}
