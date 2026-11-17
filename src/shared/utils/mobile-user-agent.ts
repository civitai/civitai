/** The user-agent test shared by the server's `isMobileUserAgent` and the client's `isMobileDevice`, kept in one place so both guess the same device class. */
export const MOBILE_USER_AGENT_PATTERN = /Mobi|Android/i;

export function isMobileUserAgent(userAgent: string | undefined) {
  return !!userAgent && MOBILE_USER_AGENT_PATTERN.test(userAgent);
}
