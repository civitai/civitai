import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseForm, parseIdList, parseQuery } from '$lib/server/query';
import { BULK_SOURCES } from './sources';
import { DEFAULT_LIMIT, MAX_LIMIT } from './limits';
import { VIOLATION_TYPES } from '$lib/violations';
import { MAX_INT4, usersByIds } from '$lib/server/users.service';
import { resolveUserId, resolveUsername } from '$lib/server/user-lookup.service';
import {
  removeAllImagesForUser,
  removeImages,
  restoreImages,
  setImageFlag,
} from '$lib/server/user-actions.service';
import { sendModNotification } from '$lib/server/moderation-memory.service';
import {
  getBatchOwners,
  getImagesByIds,
  getImagesForCollection,
  getImagesForModel,
  getImagesForModelVersion,
  getImagesForPost,
  getImagesForUser,
  countBlockedImages,
  strikeBatchOwners,
  type BulkBatch,
} from '$lib/server/bulk-image.service';
import { imageFlagValueSchema, splitImageFlagValue } from '$lib/image-flags';

// `source` + `q` in the URL so a moderator can hand a colleague the exact batch they are looking at.
// `limit` rides along for the same reason. Retool's cap was 200 and that stayed the default, but an
// account with more than that could only be worked 200 at a time with no way to reach the rest short of
// the account-wide nuke — which is not a review, it is a purge.
const querySchema = z.object({
  source: z.enum(BULK_SOURCES).catch('post'),
  q: z.string().trim().catch(''),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).catch(DEFAULT_LIMIT),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const { source, q, limit } = parseQuery(url, querySchema);
  // Reaching the page is an investigation permission; removing content is not.
  const canAct = canAccess(locals.user, '/users');

  if (!q)
    return {
      source,
      q,
      limit,
      canAct,
      batch: null,
      notFound: false,
      owners: [],
      subjectUserId: null,
    };

  // The id-list source is the one that isn't a single id — Retool took it as newlines, and a pasted
  // column from a spreadsheet arrives that way, so both separators are accepted.
  if (source === 'imageIds') {
    const ids = parseIdList(q.replace(/[\s\n]+/g, ','));
    const batch = await getImagesByIds(ids, limit);
    const ownerIds = [...new Set(batch.items.map((i) => i.userId))];
    const owners = [...(await usersByIds(ownerIds))].map(([id, u]) => ({ id, ...u }));
    return {
      source,
      q,
      limit,
      canAct,
      batch,
      notFound: batch.items.length === 0,
      owners,
      subjectUserId: null,
    };
  }

  const byUser = source === 'user' || source === 'userRemoved';
  // Bound BEFORE resolving: `resolveUserId` compares an all-digit term against an int4 column, so one
  // fat-fingered extra digit errored out of `load` and rendered a 500 instead of "no images found".
  if (/^\d+$/.test(q) && Number(q) > MAX_INT4)
    return {
      source,
      q,
      limit,
      canAct,
      batch: null,
      notFound: true,
      owners: [],
      subjectUserId: null,
    };

  const id = byUser ? await resolveUserId(q) : /^\d+$/.test(q) ? Number(q) : null;
  if (!id || id > MAX_INT4)
    return {
      source,
      q,
      limit,
      canAct,
      batch: null,
      notFound: true,
      owners: [],
      subjectUserId: null,
    };

  const batch: BulkBatch =
    source === 'post'
      ? await getImagesForPost(id, limit)
      : source === 'model'
      ? await getImagesForModel(id, limit)
      : source === 'modelVersion'
      ? await getImagesForModelVersion(id, limit)
      : source === 'collection'
      ? await getImagesForCollection(id, limit)
      : await getImagesForUser(id, limit, source === 'userRemoved');

  // Whose content this batch actually is. A model's images belong to whoever posted them, which is
  // often not the model's owner — so a removal here can touch accounts the moderator did not look up.
  const ownerIds = [...new Set(batch.items.map((i) => i.userId))];
  const owners = [...(await usersByIds(ownerIds))].map(([id, u]) => ({ id, ...u }));

  // The RESOLVED account, not the term that was typed: the account-wide removal below is scoped by id,
  // and `q` may be a username, a display name or a stale id.
  return {
    source,
    q,
    limit,
    canAct,
    batch,
    notFound: batch.items.length === 0,
    owners,
    subjectUserId: byUser ? id : null,
  };
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
        // Retool's strikeCheckbox. `z.coerce.boolean()` would read the string "false" as true, and a
        // checkbox is absent-or-its-value, so match the value it posts.
        strikeOwners: z
          .literal('1')
          .optional()
          .transform((v) => v === '1'),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return actionFail(input);
    // The strike's description is what the account is shown. Refused BEFORE the removal: after it, the
    // images are gone and the moderator's other half of the gesture cannot be retried from here.
    if (input.strikeOwners && !input.reason)
      return actionFail('A strike needs a reason — it is the message the user is sent.');

    // BEFORE the write, or every id reads as already-blocked afterwards.
    const alreadyBlocked = await countBlockedImages(input.imageIds);

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

    // Same ordering as the flag: a failed removal must not strike anybody.
    const struck =
      input.strikeOwners && input.reason
        ? await strikeBatchOwners({
            imageIds: input.imageIds,
            description: input.reason,
            moderatorId: locals.user.id,
          })
        : null;

    const strikeWarning = struck?.error
      ? `Struck ${struck.struck} of ${struck.owners} owners: ${struck.error}`
      : undefined;

    return {
      success: true,
      removed: result.count,
      alreadyBlocked,
      struck: struck?.struck,
      // Both halves are reported, and the strike one wins the single warning slot: a missing flag is
      // recoverable from this screen, an unissued strike is not. A removal that changed nothing is
      // last, because it is the only one of the three that is not a partial failure of the action.
      warning:
        strikeWarning ??
        flagWarning ??
        (result.count - alreadyBlocked === 0
          ? 'Nothing changed — every image submitted was already blocked.'
          : undefined),
    };
  },

  // Retool's image-only account nuke. Unlike every other action here it is NOT scoped to the ids on
  // screen — the endpoint takes the account and blocks everything it owns, including the images past
  // the 200-image cap this page loads, which is the only reason it exists.
  removeAllForUser: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return actionFail('Not permitted.');
    const input = parseForm(
      z.object({
        userId: z.coerce.number().int().positive().max(MAX_INT4),
        confirm: z.string().trim().min(1),
        reason: z.string().trim().max(500).optional(),
        violationType: z.enum(VIOLATION_TYPES).optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return actionFail(input);

    // Resolved SERVER-side and compared here: the confirmation has to name the account the server is
    // about to empty, not the one the page happened to render.
    const account = await resolveUsername(input.userId);
    if (!account) return actionFail('User not found.');
    const expected = account.username ?? String(input.userId);
    if (input.confirm.toLowerCase() !== expected.toLowerCase())
      return actionFail(`Type ${expected} exactly to confirm — nothing was removed.`);

    const result = await removeAllImagesForUser({
      userId: input.userId,
      reason: input.reason || undefined,
      violationType: input.violationType,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return actionFail(result.error);
    return { success: true, removedAll: result.count, account: expected };
  },

  restore: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return actionFail('Not permitted.');
    const input = parseForm(idsSchema, await request.formData());
    if (typeof input === 'string') return actionFail(input);

    const blocked = await countBlockedImages(input.imageIds);

    const result = await restoreImages({
      imageIds: input.imageIds,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return actionFail(result.error);
    return { success: true, restored: result.count, wasBlocked: blocked };
  },

  // Retool's TogglePoIMakeSureToEdit. It hardcoded poi/true; both are choices here, so a flag set in
  // error can be cleared from the same screen.
  setFlag: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return actionFail('Not permitted.');
    const input = parseForm(
      // A submit button carries one name/value pair, so the flag and the direction share a field.
      idsSchema.extend({
        flagValue: imageFlagValueSchema,
      }),
      await request.formData()
    );
    if (typeof input === 'string') return actionFail(input);

    const result = await setImageFlag({
      ...splitImageFlagValue(input.flagValue),
      imageIds: input.imageIds,
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
