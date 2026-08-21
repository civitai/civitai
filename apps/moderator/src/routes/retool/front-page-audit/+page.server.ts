import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseForm, parseQuery } from '$lib/server/query';
import { validNsfwLevels, NsfwLevel } from '@civitai/shared';
import { updateImageNsfwLevel } from '$lib/server/image-nsfw-level';
import {
  getSweep,
  voteOnTag,
  recordResearchRating,
  recordRatingChange,
  getImageRating,
  SWEEP_LIMITS,
} from '$lib/server/front-page-audit.service';
import { getSweepCheckpoint, markSweepChecked } from '$lib/server/front-page-timers';
import { SWEEP_MEDIA, SWEEP_ORDERS } from './sweep';

const querySchema = z.object({
  level: z.coerce.number().int().catch(NsfwLevel.PG13),
  order: z.enum(SWEEP_ORDERS).catch('newest'),
  media: z.enum(SWEEP_MEDIA).catch('image'),
  hours: z.coerce.number().int().min(1).max(720).catch(24),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const { level, order, media, hours } = parseQuery(url, querySchema);
  const nsfwLevel = validNsfwLevels.has(level) ? level : NsfwLevel.PG13;

  // The shared resume point wins over the `hours` dropdown when there is one, which is what makes this
  // a queue two moderators can drain together rather than two people re-reading the same rows. An
  // explicit `?hours=` is still honoured — that is someone deliberately looking outside the checkpoint.
  // Only the newest-first IMAGE sweep participates. `reactions` ignores `since` entirely, so a
  // checkpoint banner over it would describe a window that is not in force; and the checkpoint is keyed
  // on rating alone, so letting the 20-row video sweep advance it would skip every image created in the
  // same span — a population nobody looked at.
  const sharesCheckpoint = order === 'newest' && media === 'image';
  const checkpoint = sharesCheckpoint ? await getSweepCheckpoint(nsfwLevel) : null;
  const windowed = new Date(Date.now() - hours * 3600_000);
  const usingCheckpoint = sharesCheckpoint && !url.searchParams.has('hours') && !!checkpoint;
  const since = usingCheckpoint && checkpoint ? checkpoint.lastCheckedAt : windowed;

  const items = await getSweep({ nsfwLevel, order, media, since });

  return {
    nsfwLevel,
    order,
    media,
    hours,
    since,
    checkpoint,
    usingCheckpoint,
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

    // BEFORE the update: this is the level being swept, and it is half of the audit row below.
    const originalRating = await getImageRating(input.imageId);

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
    // Retool's InsertRatingGame, after the rating commits — the research dataset must not be able to
    // fail the moderation action it describes.
    await recordResearchRating({
      userId: locals.user.id,
      imageId: input.imageId,
      nsfwLevel: input.nsfwLevel,
    });

    // Retool's LogNsfwLevel, the before/after trail `recordModActivity` does not keep. Skipped when the
    // old level could not be read: a row whose `originalRating` is a guess is worse than no row.
    if (originalRating !== null)
      await recordRatingChange({
        imageId: input.imageId,
        originalRating,
        rating: input.nsfwLevel,
        updatedBy: locals.user.username ?? null,
      });

    return { success: true, rated: input.imageId, nsfwLevel: input.nsfwLevel };
  },

  // Retool's green "Log" button. Advances the SHARED resume point so the next sweep — anyone's — starts
  // where this one stopped.
  markSwept: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/retool/front-page-audit')) return actionFail('Not permitted.');
    const username = locals.user.username;
    if (!username) return actionFail('Your account has no username.');

    const input = parseForm(
      z.object({
        nsfwLevel: z.coerce.number().int(),
        // The `createdAt` of the last row on the page just swept — not `now()`. Anything posted while
        // the moderator worked has not been looked at and must survive into the next window.
        lastCheckedAt: z.coerce.date(),
        order: z.enum(SWEEP_ORDERS),
        media: z.enum(SWEEP_MEDIA),
        // Whether the sweep STARTED from the shared point. Re-derived here rather than trusted: it is
        // the client saying which queue it drained.
        fromCheckpoint: z.string().optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return actionFail(input);
    if (!validNsfwLevels.has(input.nsfwLevel)) return actionFail('Not a rating a sweep can set.');
    // Retool disabled Log on the Reaction ordering: it ranks by popularity, not time, so its last row
    // says nothing about how far the queue has been drained and would move the point backwards.
    if (input.order !== 'newest' || input.media !== 'image')
      return actionFail('Only the newest-first image sweep has a resume point.');

    // 🔴 Advancing the SHARED point from a private window silently discards everything between the two.
    // A moderator on a 24h window whose shared point is five days back would jump it to today and drop
    // four days nobody has looked at, with nothing on screen recording it.
    const current = await getSweepCheckpoint(input.nsfwLevel);
    if (input.fromCheckpoint !== '1')
      return actionFail(
        'This sweep started from your own window, not the shared one — resume the shared sweep before marking it.'
      );
    if (current && input.lastCheckedAt < current.lastCheckedAt)
      return actionFail('That would move the shared point backwards. Reload and sweep again.');

    await markSweepChecked({
      nsfwLevel: input.nsfwLevel,
      lastCheckedAt: input.lastCheckedAt,
      username,
    });
    return { success: true, swept: input.lastCheckedAt.toISOString() };
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
