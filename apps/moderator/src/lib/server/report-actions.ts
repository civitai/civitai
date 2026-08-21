import { fail, type Actions } from '@sveltejs/kit';
import { z } from 'zod';
import { canAccess } from './access';
import { parseForm, parseIdList, userIdSchema, checkboxField } from './query';
import { issueStrike, restoreImages, setImageFlag } from './user-actions.service';
import { countBlockedImages, removeImagesWithFollowUps } from './bulk-image.service';
import { sendModNotification } from './moderation-memory.service';
import { setReportStatus } from './reports.service';
import { VIOLATION_TYPES } from '$lib/violations';
import { MAX_INT4 } from './users.service';
import { ReportStatus } from '$lib/reports';
import { imageFlagValueSchema, splitImageFlagValue } from '$lib/image-flags';

/**
 * The action half of a report queue: rule on the report, act on the content, act on the owner.
 *
 * A FACTORY taking the gate path, not a bare object: `apps/moderator/CLAUDE.md` requires an action to be
 * gated on its own page's path, and welding one in here would make that a property of the shared module
 * instead of a per-page decision.
 */

type Scope = 'report' | 'strike' | 'notify' | 'images';
const scopedFail = (scope: Scope, message: string) => fail(400, { scope, error: message });

const idsSchema = z.object({
  imageIds: z
    .string()
    .transform((s) => parseIdList(s, 5001))
    .refine((ids) => ids.length > 0, 'Select at least one image.')
    .refine((ids) => ids.length <= 5000, 'Too many images in one batch — narrow the selection.'),
});

export function reportModerationActions(pagePath: string) {
  const permitted = (locals: App.Locals) => canAccess(locals.user, pagePath);

  return {
    // Retool's ActionReport. `setReportStatus` also rewards the reporters when a report is Actioned and
    // refuses to double-reward, which Retool's raw REST call did not.
    actionReport: async ({ request, locals, getClientAddress }) => {
      if (!permitted(locals)) return scopedFail('report', 'Not permitted.');
      const input = parseForm(
        z.object({
          id: z.coerce.number().int().positive().max(MAX_INT4),
          // Claiming was removed at the team's request, so `Processing` is no longer reachable from a
          // queue. It is still a status they FILTER on — reports carrying it predate the removal.
          status: z.enum([ReportStatus.Actioned, ReportStatus.Unactioned]),
        }),
        await request.formData()
      );
      if (typeof input === 'string') return scopedFail('report', input);

      const result = await setReportStatus({
        id: input.id,
        status: input.status,
        userId: locals.user.id,
        ip: getClientAddress(),
      });
      if (!result.ok) return scopedFail('report', result.error);
      return { success: true };
    },

    // Retool's InsertStrike + LogStrike + InsertStrikeNotif. Writes the MAIN APP's strike system: a row
    // in the moderator database's legacy `UserStrikes` gets no escalation, points, expiry, typed
    // notification or void path. See issueStrike.
    strike: async ({ request, locals }) => {
      if (!permitted(locals)) return scopedFail('strike', 'Not permitted.');
      const input = parseForm(
        userIdSchema.extend({ reason: z.string().trim().min(1).max(1000) }),
        await request.formData()
      );
      if (typeof input === 'string') return scopedFail('strike', input);

      const result = await issueStrike({
        userId: input.userId,
        description: input.reason,
        moderatorId: locals.user.id,
      });
      if (!result.ok) return scopedFail('strike', result.error);
      // No "could not notify" branch: `createStrike` sends the typed notification and its email inside
      // the same call, so there is no separate step here to half-fail.
      return { success: true };
    },

    // Retool's strikeCheckbox path: acting on a report means removing the images it is about, from the
    // same screen. The endpoints are the ones Bulk Image Manager uses.
    remove: async ({ request, locals }) => {
      if (!permitted(locals)) return scopedFail('images', 'Not permitted.');
      const input = parseForm(
        idsSchema.extend({
          reason: z.string().trim().max(500).optional(),
          violationType: z.enum(VIOLATION_TYPES).optional(),
          // Retool's TosReasons carried a flag alongside the message; setting it is part of the same
          // gesture, so a POI removal does not need a second pass to mark the images.
          alsoFlag: z.enum(['poi', 'minor', 'tag']).optional(),
          strikeOwners: checkboxField,
        }),
        await request.formData()
      );
      if (typeof input === 'string') return scopedFail('images', input);

      const result = await removeImagesWithFollowUps({ ...input, moderatorId: locals.user.id });
      if (!result.ok) return scopedFail('images', result.error);

      // A silent flag failure is worse than none: the moderator believes the images are marked.
      const flagNote = result.flag?.applied
        ? ''
        : result.flag
        ? ` The ${result.flag.flag} flag was NOT applied: ${result.flag.error}`
        : '';
      const strikeNote = result.struck
        ? result.struck.error
          ? ` Struck ${result.struck.struck} of ${result.struck.owners} owners: ${result.struck.error}`
          : ` Struck ${result.struck.struck} owner${result.struck.struck === 1 ? '' : 's'}.`
        : '';

      return {
        success: true,
        // The endpoint counts rows FOUND; the already-blocked share is subtracted so re-removing a
        // blocked batch cannot report a full removal.
        imageResult:
          `Removed ${result.removed - result.alreadyBlocked} of ${input.imageIds.length}` +
          `${result.alreadyBlocked > 0 ? ` (${result.alreadyBlocked} already blocked)` : ''}.` +
          `${flagNote}${strikeNote}`,
      };
    },

    restore: async ({ request, locals }) => {
      if (!permitted(locals)) return scopedFail('images', 'Not permitted.');
      const input = parseForm(idsSchema, await request.formData());
      if (typeof input === 'string') return scopedFail('images', input);

      const wasBlocked = await countBlockedImages(input.imageIds);

      const result = await restoreImages({ imageIds: input.imageIds, moderatorId: locals.user.id });
      if (!result.ok) return scopedFail('images', result.error);
      return {
        success: true,
        imageResult:
          `Restored ${result.count} of ${input.imageIds.length}` +
          `${result.count > wasBlocked ? ` (${result.count - wasBlocked} were not blocked)` : ''}.`,
      };
    },

    setFlag: async ({ request, locals }) => {
      if (!permitted(locals)) return scopedFail('images', 'Not permitted.');
      const input = parseForm(
        idsSchema.extend({ flagValue: imageFlagValueSchema }),
        await request.formData()
      );
      if (typeof input === 'string') return scopedFail('images', input);

      const result = await setImageFlag({
        ...splitImageFlagValue(input.flagValue),
        imageIds: input.imageIds,
        moderatorId: locals.user.id,
      });
      if (!result.ok) return scopedFail('images', result.error);
      return { success: true, imageResult: `Updated ${input.imageIds.length} images.` };
    },

    // Retool's SendNotification2 / PostNotification / SendCorrectNotif — three call sites, one action.
    notify: async ({ request, locals }) => {
      if (!permitted(locals)) return scopedFail('notify', 'Not permitted.');
      const input = parseForm(
        userIdSchema.extend({ message: z.string().trim().min(1).max(1000) }),
        await request.formData()
      );
      if (typeof input === 'string') return scopedFail('notify', input);

      const result = await sendModNotification({
        userId: input.userId,
        message: input.message,
        moderatorId: locals.user.id,
      });
      if (!result.ok) return scopedFail('notify', result.error);
      return { success: true };
    },
  } satisfies Actions;
}
