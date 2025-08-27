import { env } from '~/env/client';

export const colorDomains = {
  green: env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN,
  blue: env.NEXT_PUBLIC_SERVER_DOMAIN_BLUE,
  red: env.NEXT_PUBLIC_SERVER_DOMAIN_RED,
};
export type ColorDomain = keyof typeof colorDomains;

export function getRequestDomainColor(req: { headers: { host?: string } }) {
  const { host } = req?.headers ?? {};
  if (!host) return undefined;
  for (const [color, domain] of Object.entries(colorDomains)) {
    if (host === domain) return color as ColorDomain;
  }
}
