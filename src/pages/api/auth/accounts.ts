import type { NextApiRequest, NextApiResponse } from 'next';
import { createDeviceAccountClient } from '@civitai/auth';

// Same-origin proxy for the device's linked-account set — the browser hits this so its `.civitai.com` cookies
// (civ-token + civ-device) ride along; we forward them to the hub via the @civitai/auth device client (the hub
// URL/contract lives in the package, not here).
//   GET    → the display-only list for the account switcher
//   DELETE ?userId=N → remove that account from this browser's device set
// See docs/main-app-auth-cutover.md (section E).
const deviceAccounts = createDeviceAccountClient();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cookie = req.headers.cookie ?? '';

  if (req.method === 'DELETE') {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ ok: false });
    const ok = await deviceAccounts.remove(cookie, userId);
    return res.status(ok ? 200 : 502).json({ ok });
  }

  const accounts = await deviceAccounts.list(cookie);
  return res.status(200).json({ accounts });
}
