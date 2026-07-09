import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';

// The first-party SessionProvider + useSession (and the ~317 useCurrentUser sites) poll this endpoint. It returns
// the hub-resolved session (civ-token, or a legacy civitai-token via the jose decoder) in the `{ user, expires }`
// shape the client expects. (Replaced the old next-auth [...nextauth] /api/auth/session route.)
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
