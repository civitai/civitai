import { env } from '~/env/server';
import type { ColorDomain, ServerDomains } from '~/shared/constants/domain.constants';

export const serverDomainMap: ServerDomains = {
  green: env.SERVER_DOMAIN_GREEN,
  blue: env.SERVER_DOMAIN_BLUE,
  red: env.SERVER_DOMAIN_RED,
};

export function getRequestDomainColor(req: { headers: { host?: string } }) {
  const host = req?.headers?.host;
  if (!host) return undefined;
  for (const [color, domain] of Object.entries(serverDomainMap)) {
    if (!domain) continue;
    if (host === domain) return color as ColorDomain;
    // Match any localhost port against a localhost domain
    if (host.startsWith('localhost:') && domain.startsWith('localhost:'))
      return color as ColorDomain;
  }
}
