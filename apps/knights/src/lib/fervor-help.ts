/** Set client-side when a viewer collapses "How fervor works", so the server can render it closed with no flash. */
export const HELP_COOKIE = 'knights_fervor_help';

const YEAR_SECONDS = 31_536_000;

export const helpCookie = (closed: boolean): string =>
  closed
    ? `${HELP_COOKIE}=closed; path=/; max-age=${YEAR_SECONDS}; SameSite=Lax`
    : `${HELP_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
