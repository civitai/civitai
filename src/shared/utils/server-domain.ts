import { env } from '~/env/client';

export const serverDomainMap = {
  green: env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN,
  blue: env.NEXT_PUBLIC_SERVER_DOMAIN_BLUE,
  red: env.NEXT_PUBLIC_SERVER_DOMAIN_RED,
} as const;

export type ServerAvailability = keyof typeof serverDomainMap;
