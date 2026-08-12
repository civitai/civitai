import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { takeLinkSyncCookie } from '~/server/auth/link-sync';
import { safePath } from '~/server/auth/oauth-bridge';
import { syncUserDiscordLeaderboardRoles } from '~/server/jobs/apply-discord-roles';
import { logToAxiom } from '~/server/logging/client';

// GET /api/auth/linked?provider=<id>&returnUrl=<same-origin path> — the hub's return target for the account-LINK
// flow started by /api/auth/connect. Runs the main app's post-link side effects (the hub has neither the main DB
// nor the Discord bot token) and then forwards to where the user was actually headed, preserving the hub's
// ?error.
//
// The user is already linked by the time we get here, so nothing in here may keep them on this endpoint: the
// side effect is capped and its failure only ever costs a log line.
const SYNC_TIMEOUT = 5000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
  const error = typeof req.query.error === 'string' ? req.query.error : undefined;
  const initiatedHere = takeLinkSyncCookie(req, res);

  if (provider === 'discord' && !error && initiatedHere) {
    try {
      const session = await getServerAuthSession({ req, res });
      const userId = session?.user?.id;
      if (userId)
        await Promise.race([
          syncUserDiscordLeaderboardRoles(userId),
          new Promise((resolve) => setTimeout(resolve, SYNC_TIMEOUT)),
        ]);
    } catch (e) {
      logToAxiom({
        type: 'discord-link-sync-error',
        name: 'auth-linked',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const destination = new URL(safePath(req.query.returnUrl), 'https://placeholder.invalid');
  if (error) destination.searchParams.set('error', error);

  res.redirect(302, `${destination.pathname}${destination.search}${destination.hash}`);
}
