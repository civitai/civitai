import type { Context } from '~/server/createContext';

/**
 * Whether this request may see images listed on a report: the held-media viewer
 * (src/pages/api/mod/held-media), a moderator holding the csamReports grant.
 */
export const seesReportListed = (ctx: Pick<Context, 'user' | 'features'>) =>
  !!ctx.user?.isModerator && !!ctx.features?.csamReports;
