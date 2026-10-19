import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad, RequestEvent } from './$types';
import { MAX_BOX_WEIGHT } from '@civitai/shared/box-odds';
import { EMPTY_RULES, MAX_GRANT_USERS, parseUserIdList, TIER_KEY_PATTERN } from '$lib/mystery-box';
import {
  archiveBox,
  BoxRefusal,
  createBoxListing,
  readBoxForEditor,
  recordOutsideChange,
  saveBox,
  updateBoxListing,
} from '$lib/server/mystery-box-builder.service';
import { readCosmeticEvents } from '$lib/server/item-definitions.service';
import { int4Id, jsonField, parseForm } from '$lib/server/query';
import { recordModActivity } from '$lib/server/mod-activity';
import { requiresGrant } from '$lib/server/access';
import {
  boxGrantFields,
  BoxGrantRefused,
  grantMysteryBoxes,
} from '$lib/server/mystery-box-grant.service';

const boxIdOf = (params: { id: string }) => {
  const parsed = int4Id.safeParse(params.id);
  if (!parsed.success) error(404, 'No such box.');
  return parsed.data;
};

export const load: PageServerLoad = async ({ params }) => {
  const boxId = boxIdOf(params);
  const [editor, events] = await Promise.all([readBoxForEditor(boxId), readCosmeticEvents()]);
  if (!editor) error(404, 'No such box.');
  return { ...editor, events };
};

const url = z.union([z.literal(''), z.url().max(1000)]);

const draftSchema = z.object({
  name: z.string().max(200),
  description: z.string().max(2000),
  imageUrl: url,
  event: z.string().max(100),
  emptyRule: z.enum(EMPTY_RULES),
  art: z.record(z.string().max(50), z.object({ closed: url.optional(), open: url.optional() })),
  tiers: z
    .array(
      z.object({
        id: int4Id.nullable(),
        key: z.string().regex(TIER_KEY_PATTERN),
        name: z.string().max(50),
        weight: z.number().int().positive().max(MAX_BOX_WEIGHT),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullable(),
      })
    )
    .max(20),
  contents: z
    .array(
      z.object({
        id: int4Id.nullable(),
        rewardDefinitionId: int4Id,
        tierKey: z.string(),
        enabled: z.boolean(),
      })
    )
    .max(5000),
});

const saveSchema = z.object({
  expectedVersion: z.coerce.number().int().positive(),
  expectedUpdatedAt: z.iso.datetime(),
  draft: jsonField(draftSchema, 'Unreadable box.'),
});

const versionSchema = z.object({ expectedVersion: z.coerce.number().int().positive() });

const grantSchema = z.object({
  userIds: z.string().transform((value, ctx) => {
    const ids = parseUserIdList(value);
    const bad = ids.find((id) => !int4Id.safeParse(id).success);
    if (bad !== undefined) ctx.addIssue({ code: 'custom', message: `Not a user id: ${bad}` });
    else if (!ids.length) ctx.addIssue({ code: 'custom', message: 'Name at least one user id.' });
    else if (ids.length > MAX_GRANT_USERS)
      ctx.addIssue({ code: 'custom', message: `At most ${MAX_GRANT_USERS} users at a time.` });
    return ids.map(Number);
  }),
  ...boxGrantFields,
});

const listingSchema = z
  .object({
    listingId: int4Id.optional(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000),
    unitAmount: z.coerce.number().int().positive().max(1_000_000),
    availableFrom: z.string().trim(),
    availableTo: z.string().trim(),
    availableQuantity: z.string().trim(),
    status: z.enum(['Draft', 'Published', 'Archived']),
  })
  .transform(({ availableFrom, availableTo, availableQuantity, description, ...rest }, ctx) => {
    // A value with no offset is UTC, not the server's zone.
    const date = (value: string) =>
      value ? new Date(/(Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}Z`) : null;
    const from = date(availableFrom);
    const to = date(availableTo);
    const quantity = availableQuantity ? Number(availableQuantity) : null;
    if ((from && isNaN(from.getTime())) || (to && isNaN(to.getTime())))
      ctx.addIssue({ code: 'custom', message: 'A sale date is not a date.' });
    else if (from && to && from >= to)
      ctx.addIssue({ code: 'custom', message: 'The sale must end after it starts.' });
    if (quantity !== null && (!Number.isSafeInteger(quantity) || quantity <= 0))
      ctx.addIssue({ code: 'custom', message: 'The quantity must be a whole number above 0.' });
    return {
      ...rest,
      description: description || null,
      availableFrom: from,
      availableTo: to,
      availableQuantity: quantity,
    };
  });

/**
 * Answers a refusal with `fail`, never a throw: a throw renders the error page, which unmounts the
 * editor and loses its unsaved work.
 */
async function refusable<T>(scope: string, write: () => Promise<T>) {
  try {
    return await write();
  } catch (e) {
    if (e instanceof BoxRefusal) return fail(409, { scope, error: e.message });
    console.error('[mystery-box-builder] write failed', e);
    return fail(500, { scope, error: 'Saving failed. Nothing was changed; try again.' });
  }
}

const record = (userId: number, boxId: number, activity: string) =>
  recordModActivity({ userId, entityType: 'mysteryBox', entityId: boxId, activity });

async function save({ request, params, locals }: RequestEvent, publish: boolean) {
  const boxId = boxIdOf(params);
  const input = parseForm(saveSchema, await request.formData());
  if (typeof input === 'string') return fail(400, { scope: 'save', error: input });
  return refusable('save', async () => {
    const result = await saveBox({ boxId, ...input, publish, userId: locals.user.id });
    await record(
      locals.user.id,
      boxId,
      publish ? 'publishBox' : result.bumped ? 'editBoxOdds' : 'editBox'
    );
    return { scope: 'save', saved: result };
  });
}

export const actions: Actions = {
  save: (event) => save(event, false),
  publish: (event) => save(event, true),
  recordOutsideChange: async ({ request, params, locals }) => {
    const boxId = boxIdOf(params);
    const input = parseForm(versionSchema, await request.formData());
    if (typeof input === 'string')
      return fail(400, { scope: 'version', error: 'Reload the box and try again.' });
    return refusable('version', async () => {
      const version = await recordOutsideChange({ boxId, ...input, userId: locals.user.id });
      await record(locals.user.id, boxId, 'recordBoxChange');
      return { scope: 'version', version };
    });
  },
  archive: async ({ params, locals }) => {
    const boxId = boxIdOf(params);
    return refusable('status', async () => {
      await archiveBox({ boxId, userId: locals.user.id });
      await record(locals.user.id, boxId, 'archiveBox');
      return { scope: 'status', archived: true };
    });
  },
  grant: requiresGrant('items.boxes.grant', async ({ request, params, locals }) => {
    const boxId = boxIdOf(params);
    const input = parseForm(grantSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'grant', error: input });
    try {
      const result = await grantMysteryBoxes({ boxId, ...input, moderatorId: locals.user.id });
      // Echoed: the form's count field may have changed by the time the result arrives.
      return { scope: 'grant', count: input.count, ...result };
    } catch (e) {
      if (e instanceof BoxGrantRefused) return fail(409, { scope: 'grant', error: e.message });
      // A throw would render the error page over the editor's unsaved work.
      console.error('[mystery-box-grant] grant failed', e);
      return fail(500, {
        scope: 'grant',
        error: 'Granting failed before anyone was given a box. Try again.',
      });
    }
  }),
  listing: async ({ request, params, locals }) => {
    const boxId = boxIdOf(params);
    const input = parseForm(listingSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'listing', error: input });
    const { listingId, ...listing } = input;
    return refusable('listing', async () => {
      if (listingId) await updateBoxListing({ boxId, listingId, listing });
      else await createBoxListing({ boxId, listing, userId: locals.user.id });
      await record(locals.user.id, boxId, listingId ? 'editBoxListing' : 'createBoxListing');
      return { scope: 'listing', listingSaved: true };
    });
  },
};
