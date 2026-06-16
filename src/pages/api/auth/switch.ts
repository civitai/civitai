import type { NextApiRequest, NextApiResponse } from 'next';
import { createDeviceAccountClient, deviceCookieName } from '@civitai/auth';
import { setSessionCookie } from '~/server/auth/civ-cookie';

// Same-origin proxy for a device-level account switch (section E). The browser hits this so its .civitai.com
// cookies (civ-token + civ-device) ride along; the @civitai/auth device client forwards them to the hub, which
// authorizes the switch (active session + the target being in THIS device's set and fresh) and returns a fresh
// civ-token. We set it as the session cookie + roll the device cookie (the hub's Set-Cookie can't cross back).
const deviceAccounts = createDeviceAccountClient();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const userId = Number(req.body?.userId);
  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'bad userId' });

  // The hub declines (null) when the target isn't linked to this device / has aged out / is unreachable →
  // the client falls back to a re-login.
  const result = await deviceAccounts.switch(req.headers.cookie ?? '', userId);
  if (!result) return res.status(403).json({ error: 'switch not allowed' });

  // Set the new session cookie + roll the device cookie in lockstep (the hub slid the device record).
  setSessionCookie(res, result.token, { deviceCookie: req.cookies[deviceCookieName()] });
  return res.status(200).json({ ok: true, userId });
}
