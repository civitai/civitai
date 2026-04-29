import { env } from '~/env/server';
import { serverDomainPrimaryMap } from '~/server/utils/server-domain';
import type { ColorDomain } from '~/shared/constants/domain.constants';

export const getBaseUrl = (color?: ColorDomain) => {
  if (color) {
    const primary = serverDomainPrimaryMap[color];
    if (primary) return `https://${primary}`;
  }

  if (typeof window !== 'undefined') return ''; // browser should use relative url
  if (env.NEXTAUTH_URL) return env.NEXTAUTH_URL;
  return `http://localhost:${process.env.PORT ?? 3000}`; // dev SSR should use localhost
};

export const getInternalUrl = () => {
  if (typeof window !== 'undefined') return ''; // browser should use relative url
  return `http://localhost:${process.env.PORT ?? 3000}`;
};
