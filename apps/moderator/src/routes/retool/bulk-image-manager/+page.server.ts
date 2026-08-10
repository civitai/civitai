import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseForm, parseIdList, parseQuery } from '$lib/server/query';
import { BULK_SOURCES } from './sources';
import { VIOLATION_TYPES } from '$lib/violations';
import { MAX_INT4, usersByIds } from '$lib/server/users.service';
import { resolveUserId } from '$lib/server/user-lookup.service';
import { removeImages, restoreImages, setImageFlag } from '$lib/server/user-actions.service';
import { sendModNotification } from '$lib/server/moderation-memory.service';
import {
  getBatchOwners,
  getImagesByIds,
  getImagesForCollection,
  getImagesForModel,
  getImagesForModelVersion,
  getImagesForPost,
  getImagesForUser,
  type BulkBatch,
} from '$lib/server/bulk-image.service';

// `source` + `q` in the URL so a moderator can hand a colleague the exact batch they are looking at.
const querySchema = z.object({
  source: z.enum(BULK_SOURCES).catch('post'),
  q: z.string().trim().catch(''),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const { source, q } = parseQuery(url, querySchema);
  // Reaching the page is an investigation permission; removing content is not.
  const canAct = canAccess(locals.user, '/users');

  if (!q) return { source, q, canAct, batch: null, notFound: false, owners: [] };

  // The id-list source is the one that isn't a single id — Retool took it as newlines, and a pasted
  // column from a spreadsheet arrives that way, so both separators are accepted.
  if (source === 'imageIds') {
    const ids = parseIdList(q.replace(/[\s\n]+/g, ','));
    const batch = await getImagesByIds(ids);
    const ownerIds = [...new Set(batch.items.map((i) => i.userId))];
    const owners = [...(await usersByIds(ownerIds))].map(([id, u]) => ({ id, ...u }));
    return { source, q, canAct, batch, notFound: batch.items.length === 0, owners };
  }

  const byUser = source === 'user' || source === 'userRemoved';
  // Bound BEFORE resolving: `resolveUserId` compares an all-digit term against an int4 column, so one
  // fat-fingered extra digit errored out of `load` and rendered a 500 instead of "no images found".
  if (/^\d+$/.test(q) && Number(q) > MAX_INT4)
    return { source, q, canAct, batch: null, notFound: true, owners: [] };

  const id = byUser ? await resolveUserId(q) : /^\d+$/.test(q) ? Number(q) : null;
  if (!id || id > MAX_INT4) return { source, q, canAct, batch: null, notFound: true, owners: [] };

  const batch: BulkBatch =
    source === 'post'
      ? await getImagesForPost(id)
      : source === 'model'
      ? await getImagesForModel(id)
      : source === 'modelVersion'
      ? await getImagesForModelVersion(id)
      : source === 'collection'
      ? await getImagesForCollection(id)
      : await getImagesForUser(id, 200, source === 'userRemoved');

  // Whose content this batch actually is. A model's images belong to whoever posted them, which is
  // often not the model's owner — so a removal here can touch accounts the moderator did not look up.
  const ownerIds = [...new Set(batch.items.map((i) => i.userId))];
  const owners = [...(await usersByIds(ownerIds))].map(([id, u]) => ({ id, ...u }));

  return { source, q, canAct, batch, notFound: batch.items.length === 0, owners };
};

const actionFail = (message: string) => fail(400, { error: message });

const idsSchema = z.object({
  imageIds: z
    .string()
    .transform((s) => parseIdList(s, 5001))
    .refine((ids) => ids.length > 0, 'Select at least one image.')
    .refine((ids) => ids.length <= 5000, 'Too many images in one batch — narrow the selection.'),
});

export const actions: Actions = {
  remove: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return actionFail('Not permitted.');
    const input = parseForm(
      idsSchema.extend({
        reason: z.string().trim().max(500).optional(),
        violationType: z.enum(VIOLATION_TYPES).optional(),
        // Retool's TosReasons carried a flag alongside the message; setting it is part of the same
        // gesture, so a POI removal does not need a second pass to mark the images.
        alsoFlag: z.enum(['poi', 'minor', 'tag']).optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return actionFail(input);

    const result = await removeImages({
      imageIds: input.imageIds,
      reason: input.reason || undefined,
      violationType: input.violationType,
      moderatorId: locals.user.id,
    });

    if (!result.ok) return actionFail(result.error);

    // ONLY once the removal has landed. Run before that check, a failed removal still flagged every
    // submitted id — thousands of images marked POI under a red "removal failed" banner.
    const flagged =
      input.alsoFlag === 'poi' || input.alsoFlag === 'minor'
        ? await setImageFlag({
            imageIds: input.imageIds,
            flag: input.alsoFlag,
            value: true,
            moderatorId: locals.user.id,
          })
        : null;

    // A silent flag failure is worse than none: the moderator believes the images are marked. `tag`
    // is offered by the reason list but is not an image flag, so say that rather than drop it.
    const flagWarning =
      flagged && !flagged.ok
        ? `The ${input.alsoFlag} flag was NOT applied: ${flagged.error}`
        : input.alsoFlag === 'tag'
        ? '"tag" is not an image flag and was not applied.'
        : undefined;

    return { success: true, removed: result.count, warning: flagWarning };
  },

  restore: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return actionFail('Not permitted.');
    const input = parseForm(idsSchema, await request.formData());
    if (typeof input === 'string') return actionFail(input);

    const result = await restoreImages({
      imageIds: input.imageIds,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return actionFail(result.error);
    return { success: true, restored: result.count };
  },

  // Retool's TogglePoIMakeSureToEdit. It hardcoded poi/true; both are choices here, so a flag set in
  // error can be cleared from the same screen.
  setFlag: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return actionFail('Not permitted.');
    const input = parseForm(
      // A submit button carries one name/value pair, so the flag and the direction share a field.
      idsSchema.extend({
        flagValue: z.enum(['poi:true', 'poi:false', 'minor:true', 'minor:false']),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return actionFail(input);

    const [flag, value] = input.flagValue.split(':');
    const result = await setImageFlag({
      imageIds: input.imageIds,
      flag: flag as 'poi' | 'minor',
      value: value === 'true',
      moderatorId: locals.user.id,
    });
    if (!result.ok) return actionFail(result.error);
    return { success: true, flagged: input.imageIds.length };
  },

  // Retool's GetBulkRemoveImageUserIdsForNotifs + SendNotification2: one message per affected ACCOUNT.
  // Notifying per image would send a 300-image removal as 300 notifications to 40 people.
  notifyOwners: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return actionFail('Not permitted.');
    const input = parseForm(
      idsSchema.extend({ message: z.string().trim().min(1).max(1000) }),
      await request.formData()
    );
    if (typeof input === 'string') return actionFail(input);

    const owners = await getBatchOwners(input.imageIds);
    if (!owners.length) return actionFail('Those images have no resolvable owners.');

    const results = await Promise.all(
      owners.map((userId) =>
        sendModNotification({ userId, message: input.message, moderatorId: locals.user.id })
      )
    );
    const failed = results.filter((r) => !r.ok).length;
    if (failed === owners.length) return actionFail('Could not notify any of the owners.');

    return {
      success: true,
      notified: owners.length - failed,
      // A partial failure is reported rather than swallowed: the moderator has to know which of the
      // affected accounts were actually told.
      warning: failed ? `${failed} of ${owners.length} owners could not be notified.` : undefined,
    };
  },
};
