import { NextApiRequest } from 'next';
import { env } from '~/env/server.mjs';
import { decryptText } from '~/server/utils/key-generator';
import { isNumber } from '~/utils/type-guards';

// List of common browser user agents
const browserUserAgents = ['mozilla', 'chrome', 'safari', 'firefox', 'opera', 'edge'];
export function isRequestFromBrowser(req: NextApiRequest): boolean {
  const userAgent = req.headers['user-agent']?.toLowerCase();
  if (!userAgent) return false;

  return browserUserAgents.some((browser) => userAgent.includes(browser));
}

type CompositeFingerprint = {
  value: string;
  userId: number;
  timestamp: number;
};

export function getDeviceFingerprint(req: NextApiRequest): CompositeFingerprint {
  if (!env.FINGERPRINT_SECRET || !env.FINGERPRINT_IV) return { value: '', userId: 0, timestamp: 0 };

  const stringifiedFingerprint = (req.headers['x-fingerprint'] as string) ?? null;
  if (!stringifiedFingerprint) return { value: '', userId: 0, timestamp: 0 };

  const decrypted = decryptText({
    text: stringifiedFingerprint,
    key: env.FINGERPRINT_SECRET,
    iv: env.FINGERPRINT_IV,
  });
  const [fingerprint, userId, timestamp] = decrypted.split(':');

  return {
    value: fingerprint,
    userId: isNumber(userId) ? parseInt(userId, 10) : 0,
    timestamp: isNumber(timestamp) ? parseInt(timestamp, 10) : 0,
  };
}
