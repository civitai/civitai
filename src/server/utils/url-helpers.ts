import { env } from '~/env/server';

export const getBaseUrl = (color?: 'green' | 'yellow' | 'red') => {
  if (color === 'green' && env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN)
    return `https://${env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN}`;
  if (color === 'red' && env.NEXT_PUBLIC_SERVER_DOMAIN_RED)
    return `https://${env.NEXT_PUBLIC_SERVER_DOMAIN_RED}`;
  if (color === 'yellow' && env.NEXT_PUBLIC_SERVER_DOMAIN_BLUE)
    return `https://${env.NEXT_PUBLIC_SERVER_DOMAIN_BLUE}`;

  if (typeof window !== 'undefined') return ''; // browser should use relative url
  if (env.NEXTAUTH_URL) return env.NEXTAUTH_URL;
  return `http://localhost:${process.env.PORT ?? 3000}`; // dev SSR should use localhost
};

export const getInternalUrl = () => {
  if (typeof window !== 'undefined') return ''; // browser should use relative url
  return `http://localhost:${process.env.PORT ?? 3000}`;
};
