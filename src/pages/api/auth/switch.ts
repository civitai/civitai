import type { NextApiRequest, NextApiResponse } from 'next';
import {
  createDeviceAccountClient,
  sessionCookieName,
  deviceCookieName,
  isSecureCookie,
} from '@civitai/auth';

// Same-origin proxy for a device-level account switch (section E). The browser hits this so its .civitai.com
// cookies (civ-token + civ-device) ride along; the @civitai/auth device client forwards them to the hub, which
// authorizes the switch (active session + the target being in THIS device's set and fresh) and returns a fresh
// civ-token. We set it as the session cookie + roll the device cookie (the hub's Set-Cookie can't cross back).
const deviceAccounts = createDeviceAccountClient();
const COOKIE_DOMAIN = process.env.AUTH_COOKIE_DOMAIN;
const DEVICE_TTL_S = 30 * 24 * 60 * 60; // 30d, matches the hub's device record

function decodeExp(token: string): number | undefined {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof p?.exp === 'number' ? p.exp : undefined;
  } catch {
    return undefined;
  }
}

function buildCookie(name: string, value: string, secure: boolean, maxAge?: number): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    ...(COOKIE_DOMAIN ? [`Domain=${COOKIE_DOMAIN}`] : []),
    ...(maxAge != null ? [`Max-Age=${maxAge}`] : []),
  ].join('; ');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const userId = Number(req.body?.userId);
  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'bad userId' });

  // The hub declines (null) when the target isn't linked to this device / has aged out / is unreachable →
  // the client falls back to a re-login.
  const result = await deviceAccounts.switch(req.headers.cookie ?? '', userId);
  if (!result) return res.status(403).json({ error: 'switch not allowed' });
  const { token } = result;

  const secure = isSecureCookie();
  const exp = decodeExp(token);
  const maxAge = exp ? Math.max(0, exp - Math.floor(Date.now() / 1000)) : undefined;
  const device = req.cookies[deviceCookieName()];

  const cookies = [buildCookie(sessionCookieName(), token, secure, maxAge)];
  // Roll the device cookie too (the hub touched the record; keep the cookie in lockstep).
  if (device) cookies.push(buildCookie(deviceCookieName(), device, secure, DEVICE_TTL_S));
  res.setHeader('Set-Cookie', cookies);

  return res.status(200).json({ ok: true, userId });
}
