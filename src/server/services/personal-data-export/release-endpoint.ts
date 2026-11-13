import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { trackModActivity } from '~/server/services/moderator.service';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { releaseExport } from './personal-data-export.service';

/** What the moderator is told. Never says which hold applies. */
export const RELEASE_REFUSALS = {
  'not-releasable': 'This export is not built, or was already released.',
  expired: 'This archive is too close to deletion to send a 48-hour link. Queue a new export.',
  held: 'This export is held and cannot be released here; contact Legal.',
  unconfirmed: 'Could not check this account right now. Nothing was sent; try again.',
  'no-email': 'The account has no email address to send the export to.',
  unconfigured: 'Exports are not configured on this server.',
} as const;

/**
 * The `/api/mod/user/personal-data-export-release` handler, kept outside `src/pages` so it can be
 * tested: the grant check, the release, the moderator's refusal wording and the audit row.
 */
export async function releaseForModerator(
  actor: { id: number; roles?: string[] },
  exportId: number,
  release: typeof releaseExport = releaseExport
) {
  if (!(await hasModeratorGrant(actor, 'user.personalDataExport.release')))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        'Releasing a personal data export needs the "user.personalDataExport.release" moderator permission.',
    });

  const result = await release({ exportId, actorId: actor.id });
  if (!result.ok) {
    if (result.reason === 'not-found') throw throwNotFoundError(`No export ${exportId}`);
    throw throwBadRequestError(RELEASE_REFUSALS[result.reason]);
  }

  let auditRecorded = true;
  try {
    await trackModActivity(actor.id, {
      entityType: 'user',
      entityId: result.userId,
      activity: 'releasePersonalDataExport',
    });
  } catch (e) {
    auditRecorded = false;
    logToAxiom({
      type: 'error',
      name: 'mod-personal-data-export-audit-failed',
      message: (e as Error).message,
      details: { moderatorId: actor.id, exportId },
    }).catch(() => undefined);
  }

  return {
    exportId,
    released: true,
    linkExpiresAt: result.expiresAt.toISOString(),
    auditRecorded,
  };
}
