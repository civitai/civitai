import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseForm, parseQuery } from '$lib/server/query';
import { validNsfwLevels, NsfwLevel } from '@civitai/shared';
import { updateImageNsfwLevel } from '$lib/server/image-nsfw-level';
import { getSweep, voteOnTag, SWEEP_LIMITS } from '$lib/server/front-page-audit.service';
import { SWEEP_MEDIA, SWEEP_ORDERS } from './sweep';

// A sweep is fully described by its URL, so a moderator can hand a colleague the exact window they are
// working — which is the coordination `FrontPageTimers` provided in Retool and is not yet ported.
const querySchema = z.object({
  level: z.coerce.number().int().catch(NsfwLevel.PG13),
  order: z.enum(SWEEP_ORDERS).catch('newest'),
  media: z.enum(SWEEP_MEDIA).catch('image'),
  hours: z.coerce.number().int().min(1).max(720).catch(24),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const { level, order, media, hours } = parseQuery(url, querySchema);
  const nsfwLevel = validNsfwLevels.has(level) ? level : NsfwLevel.PG13;
  const since = new Date(Date.now() - hours * 3600_000);

  const items = await getSweep({ nsfwLevel, order, media, since });

  return {
    nsfwLevel,
    order,
    media,
    hours,
    since,
    items,
    limit: SWEEP_LIMITS[media],
    wide: true,
    // Gated on this page's OWN path, not `/images`: that is a group node whose grant is the union of
    // its children, so `/images/to-ingest` alone would have unlocked rating here, and a moderator
    // granted only this page would have seen the sweep with no buttons and no explanation.
    canAct: canAccess(locals.user, '/retool/front-page-audit'),
  };
};

const actionFail = (message: string) => fail(400, { error: message });

export const actions: Actions = {
  // Retool's UpdateNsfwLevel + LogNsfwLevel + InsertModActivity. `updateImageNsfwLevel` owns all three
  // effects plus the model-level recompute and cache bust that Retool's bare UPDATE skipped.
  setRating: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/retool/front-page-audit')) return actionFail('Not permitted.');
    const input = parseForm(
      z.object({
        imageId: z.coerce.number().int().positive(),
        nsfwLevel: z.coerce.number().int(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return actionFail(input);
    if (!validNsfwLevels.has(input.nsfwLevel)) return actionFail('Not a rating a sweep can set.');

    // `updateImageNsfwLevel` throws bare Errors (missing image, Redis down). Uncaught, a form action
    // error replaces the whole sweep with an error page — losing 200 rows of in-progress work, and
    // sometimes AFTER the rating already committed.
    try {
      await updateImageNsfwLevel({
        id: input.imageId,
        nsfwLevel: input.nsfwLevel,
        reason: 'front-page-audit',
        userId: locals.user.id,
      });
    } catch (e) {
      console.error('[front-page-audit] setRating failed', e);
      return actionFail('Could not set that rating — it may have been removed. Reload the sweep.');
    }
    return { success: true, rated: input.imageId, nsfwLevel: input.nsfwLevel };
  },

  voteTag: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/retool/front-page-audit')) return actionFail('Not permitted.');
    const input = parseForm(
      z.object({
        imageId: z.coerce.number().int().positive(),
        tagId: z.coerce.number().int().positive(),
        direction: z.enum(['up', 'down']),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return actionFail(input);

    const result = await voteOnTag(input);
    if (!result.ok) return actionFail(result.error ?? 'Could not record that vote.');
    return { success: true, votedTag: input.tagId };
  },
};
