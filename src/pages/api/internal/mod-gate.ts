import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { isAppBlocksReviewSandboxEnabled } from '~/server/services/app-blocks-flag';

/**
 * GET/ANY /api/internal/mod-gate  (MOD REVIEW SANDBOX, #2831)
 *
 * A Traefik `forwardAuth` target guarding the temporary review-preview hosts
 * (`review-<sha>.<APPS_DOMAIN>`). Traefik forwards the original request (incl.
 * cookies) here BEFORE routing to the review block; we resolve the civitai
 * session from those cookies and:
 *   - moderator  → 200 + X-Mod-Id / X-Mod-Name response headers (Traefik can
 *     copy them upstream via authResponseHeaders if desired),
 *   - everyone else (anon, logged-in non-mod) → 401.
 *
 * The feature is dark behind the mod-only `app-blocks-review-sandbox` flag, so
 * when the flag is off this endpoint 401s EVERYONE (fail-closed) — a review
 * host can never be reachable while the feature is disabled. This is the SAME
 * server session helper every other authenticated endpoint uses, so there's no
 * bespoke auth here.
 *
 * No body is read and no method is enforced beyond rejecting nothing: Traefik
 * forwardAuth issues a GET by default but may mirror the original method, so we
 * accept any method and only inspect the session.
 *
 * ============================================================================
 * 🔴 BLOCKER — CROSS-DOMAIN COOKIE BRIDGE REQUIRED BEFORE THE FLAG IS FLIPPED
 * ============================================================================
 * This gate resolves the session from the civitai.com cookie, but the review
 * hosts live on `review-<sha>.civit.ai` — a DIFFERENT registrable domain from
 * `civitai.com`. The civitai session cookie is scoped to civitai.com (and the
 * hub `__Secure-civ-token` to `.civitai.com`); it is NOT sent on a request to a
 * `*.civit.ai` host. So a browser hitting a review host forwards NO civitai
 * cookie to this forwardAuth, `getServerAuthSession` resolves no user, and this
 * gate 401s EVERYONE — including the moderator who started the preview. The
 * feature is therefore UNREACHABLE end-to-end until a `civit.ai`-scoped auth
 * bridge exists. Candidate bridges (pick one, out of scope for this PR):
 *   (a) an oauth2-proxy / forward-auth that issues a `*.civit.ai`-scoped session
 *       cookie after the user authenticates against civitai.com, or
 *   (b) a signed, short-TTL, mod-bound token minted by `previewRequest` and
 *       embedded in the review URL (e.g. `?mr=<jwt>`), verified HERE instead of
 *       (or in addition to) the cookie — so no cross-domain cookie is needed.
 * DO NOT enable the `app-blocks-review-sandbox` flag until one of these is in
 * place and verified — otherwise the preview button produces a 401 wall. See
 * the PR's "PRE-FLAG-FLIP CHECKLIST".
 */
export default withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Resolve the session from the FORWARDED request's cookies (Traefik forwardAuth
  // forwards the original headers, including Cookie). getServerAuthSession reads
  // the hub civ-token / legacy cookie exactly as the rest of the app does.
  const session = await getServerAuthSession({ req, res }).catch(() => null);
  const user = session?.user;

  // Fail-closed on the mod-only review-sandbox flag: a disabled feature must make
  // the review host unreachable. Evaluated WITH the user's context so the
  // mod-segmented flag can match.
  const enabled = await isAppBlocksReviewSandboxEnabled({ user: user ?? undefined }).catch(
    () => false
  );

  if (!user || !user.isModerator || !enabled) {
    // 401 — Traefik forwardAuth treats any non-2xx as "deny" and returns the
    // body/status to the client.
    res.status(401).json({ error: 'Moderator access required' });
    return;
  }

  // Surface the mod identity so Traefik can forward it upstream via
  // authResponseHeaders (the review block can attribute the viewer if it wants).
  res.setHeader('X-Mod-Id', String(user.id));
  if (user.username) res.setHeader('X-Mod-Name', user.username);
  res.status(200).json({ ok: true });
});
