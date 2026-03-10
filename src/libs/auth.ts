import { env } from '~/env/client';

export const useSecureCookies = env.NEXT_PUBLIC_BASE_URL?.startsWith('https://');
export const cookiePrefix = useSecureCookies ? '__Secure-' : '';

export const civitaiTokenCookieName = `${cookiePrefix}civitai-token`;
export const callbackCookieName = `${cookiePrefix}next-auth.callback-url`;
