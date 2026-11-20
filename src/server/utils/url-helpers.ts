import { env } from '~/env/server';
import { serverDomainPrimaryMap } from '~/server/utils/server-domain';
import type { ColorDomain } from '~/shared/constants/domain.constants';

/** The host configured for `color`, or undefined; `getBaseUrl` falls back to this host instead. */
export const getColorBaseUrl = (color: ColorDomain) => {
  const primary = serverDomainPrimaryMap[color];
  return primary ? `https://${primary}` : undefined;
};

export const getBaseUrl = (color?: ColorDomain) => {
  const colorBase = color && getColorBaseUrl(color);
  if (colorBase) return colorBase;

  if (typeof window !== 'undefined') return ''; // browser should use relative url
  if (env.NEXTAUTH_URL) return env.NEXTAUTH_URL;
  return `http://localhost:${process.env.PORT ?? 3000}`; // dev SSR should use localhost
};

export const getInternalUrl = () => {
  if (typeof window !== 'undefined') return ''; // browser should use relative url
  return `http://localhost:${process.env.PORT ?? 3000}`;
};
