export const useSecureCookies = process.env.NEXTAUTH_URL?.startsWith('https://');
const cookiePrefix = useSecureCookies ? '__Secure-' : '';

export const civitaiTokenCookieName = `${cookiePrefix}civitai-token`;
export const callbackCookieName = `${cookiePrefix}next-auth.callback-url`;
