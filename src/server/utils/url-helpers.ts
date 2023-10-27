import { env } from '~/env/server.mjs';

export const getBaseUrl = () => {
  if (typeof window !== 'undefined') return ''; // browser should use relative url
  if (env.NEXTAUTH_URL) return env.NEXTAUTH_URL;
  return `http://localhost:${process.env.PORT ?? 3000}`; // dev SSR should use localhost
};

export const getInternalUrl = () => {
  if (typeof window !== 'undefined') return ''; // browser should use relative url
  return `http://localhost:${process.env.PORT ?? 3000}`;
};
