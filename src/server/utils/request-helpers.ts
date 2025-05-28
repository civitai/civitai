import type { NextApiRequest } from 'next';

// List of common browser user agents
const browserUserAgents = ['mozilla', 'chrome', 'safari', 'firefox', 'opera', 'edge'];
export function isRequestFromBrowser(req: NextApiRequest): boolean {
  const userAgent = req.headers['user-agent']?.toLowerCase();
  if (!userAgent) return false;

  return browserUserAgents.some((browser) => userAgent.includes(browser));
}

type Protocol = 'https' | 'http';
type ProtocolRequest = { headers: { 'x-forwarded-proto'?: string; origin?: string } };
export function getProtocol(req: ProtocolRequest): Protocol {
  const hasHttps = req.headers['origin']?.startsWith('https');
  const proto = hasHttps ? 'https' : req.headers['x-forwarded-proto'] ?? 'http';
  return proto as Protocol;
}
