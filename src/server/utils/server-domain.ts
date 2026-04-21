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

  // First pass: exact host match. With multiple colors on the same localhost port,
  // the earliest-declared color in `colorDomainNames` wins (green → blue → red).
  for (const [color, domain] of Object.entries(serverDomainMap)) {
    if (!domain) continue;
    if (host === domain) return color as ColorDomain;
  }

  // Fallback: host is localhost but no exact port match was configured — pick the
  // first color whose domain is also configured as localhost. Only kicks in when
  // the env points at a localhost port we don't have a declared color for.
  if (host.startsWith('localhost:')) {
    for (const [color, domain] of Object.entries(serverDomainMap)) {
      if (domain?.startsWith('localhost:')) return color as ColorDomain;
    }
  }

  return undefined;
}
