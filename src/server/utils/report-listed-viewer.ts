import type { Context } from '~/server/createContext';
import { isSessionOrFullUserKey } from '~/server/auth/full-user-credential';

/**
 * Whether this request may see images listed on a report: the held-media viewer
 * (src/pages/api/mod/held-media), a moderator holding the csamReports grant, on a session or a
 * full-access key. A scoped key or an app token never does.
 */
export const seesReportListed = (
  ctx: Pick<Context, 'user' | 'features' | 'apiKeyId' | 'apiKeyType' | 'subject' | 'tokenScope'>
) => isSessionOrFullUserKey(ctx) && !!ctx.user?.isModerator && !!ctx.features?.csamReports;

/** The report-listed viewer a read takes: `seesReportListed`, and the uploader's own on a session or a
 *  full-access key only. */
export const reportListedViewerOf = (
  ctx: Pick<Context, 'user' | 'features' | 'apiKeyId' | 'apiKeyType' | 'subject' | 'tokenScope'>
) => ({
  seesReportListed: seesReportListed(ctx),
  ownerSeesReportListed: isSessionOrFullUserKey(ctx),
});
