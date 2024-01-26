import { NextApiRequest } from 'next';

// List of common browser user agents
const browserUserAgents = ['mozilla', 'chrome', 'safari', 'firefox', 'opera', 'edge'];
export function isRequestFromBrowser(req: NextApiRequest): boolean {
  const userAgent = req.headers['user-agent']?.toLowerCase();
  if (!userAgent) return false;

  return browserUserAgents.some((browser) => userAgent.includes(browser));
}
