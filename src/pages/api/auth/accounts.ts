import type { NextApiRequest, NextApiResponse } from 'next';

// Same-origin proxy for the device's linked-account list. Forwards the browser's `.civitai.com` cookies
// (civ-token + civ-device) to the hub server-side — so no cross-origin CORS — and returns the display-only
// list for the account switcher. See docs/main-app-auth-cutover.md (section E).
const HUB = process.env.AUTH_JWT_ISSUER;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!HUB) return res.status(200).json({ accounts: [] });
  try {
    const r = await fetch(`${HUB.replace(/\/+$/, '')}/api/auth/accounts`, {
      headers: { cookie: req.headers.cookie ?? '' },
    });
    if (!r.ok) return res.status(200).json({ accounts: [] });
    return res.status(200).json(await r.json());
  } catch {
    return res.status(200).json({ accounts: [] });
  }
}
