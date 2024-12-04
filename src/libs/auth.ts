import { env } from '~/env/client.mjs';

export const useSecureCookies = env.NEXT_PUBLIC_BASE_URL?.startsWith('https://');
const cookiePrefix = useSecureCookies ? '__Secure-' : '';

export const civitaiTokenCookieName = `${cookiePrefix}civitai-token`;
export const callbackCookieName = `${cookiePrefix}next-auth.callback-url`;
