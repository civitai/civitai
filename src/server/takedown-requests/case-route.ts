import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { casePartyActionInput, casePublicRef } from '@civitai/moderation';
import { resolveClientIp } from '~/server/utils/client-ip';
import { claimRateLimitAttempt } from '~/server/utils/rate-limit-bucket';
import { appendSetCookie } from '~/server/utils/set-cookie';

// A party's private case link. The email link carries the token in the URL fragment, which no server,
// CDN or Referer sees; the case page posts it here once, and from then on it travels only in an
// httpOnly cookie scoped to this one path. The moderator app resolves it again on every call, so a
// revoked link stops working at once.
const COOKIE = 'civ-case-link';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

// Strict, so an action body that also carries a token is an action, read with the cookie's token.
const openBody = z.strictObject({ token: z.string().min(16).max(256) });
const actBody = casePartyActionInput.pick({ actionId: true, values: true, submissionId: true });

const readCookie = (req: NextApiRequest) => {
  const v = req.cookies?.[COOKIE];
  return v && v.length >= 16 && v.length <= 256 ? v : null;
};

type CaseRouteDeps = {
  /** Whether the takedownRequests flag is on for this viewer. */
  formsOpen: (req: NextApiRequest, res: NextApiResponse) => Promise<boolean>;
  /** Spends one attempt of this route's per-ip limit; rejects when it is used up. */
  claimAttempt?: (req: NextApiRequest) => Promise<void>;
};

async function claimCaseAttempt(req: NextApiRequest) {
  const claim = await claimRateLimitAttempt({
    rules: [{ limit: 120, period: 60 * 60 }],
    keyName: 'takedownRequest:case',
    user: undefined,
    req,
  });
  await claim();
}

export const createCaseRoute = ({ formsOpen, claimAttempt = claimCaseAttempt }: CaseRouteDeps) =>
  async function handler(req: NextApiRequest, res: NextApiResponse) {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const ref = casePublicRef.safeParse(req.query.publicRef);
    if (!ref.success) return res.status(404).json({ message: 'Not found' });
    const publicRef = ref.data;
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).end();
    }
    // A cross-site form post can't send JSON without a preflight this route never answers.
    if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json'))
      return res.status(415).json({ message: 'Expected JSON' });

    try {
      await claimAttempt(req);
    } catch {
      return res.status(429).json({ message: 'Too many requests. Try again later.' });
    }

    const svc = await import('~/server/services/takedown-requests.service');
    if (!svc.takedownRequestsConfigured()) return res.status(503).json({ message: 'unavailable' });
    // The forms' flag closes the case links too, so switching it off shuts the whole public surface.
    if (!(await formsOpen(req, res))) return res.status(404).json({ message: 'Not found' });
    const ip = resolveClientIp(req);
    const userAgent = req.headers['user-agent']?.slice(0, 512);

    const open = req.method === 'POST' ? openBody.safeParse(req.body) : null;
    const token = open?.success ? open.data.token : readCookie(req);
    if (!token) return res.status(401).json({ message: 'This link has expired or is not valid.' });

    if (req.method === 'GET' || open?.success) {
      const out = await svc.viewCase({ publicRef, token, ip, userAgent });
      if (!out.ok) return res.status(out.status ?? 503).json({ message: out.message });
      if (open?.success)
        appendSetCookie(
          res,
          `${COOKIE}=${encodeURIComponent(
            token
          )}; Path=/api/requests/case/${publicRef}; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`,
          { replace: true }
        );
      return res.status(200).json(out.view);
    }

    const act = actBody.safeParse(req.body);
    if (!act.success) return res.status(400).json({ message: 'Bad request' });
    const out = await svc.actOnCase({ publicRef, token, ip, userAgent, ...act.data });
    if (!out.ok)
      return res
        .status(out.status ?? 503)
        .json({ message: out.message, fieldErrors: out.fieldErrors });
    return res.status(200).json({ ok: true });
  };
