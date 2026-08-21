import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseForm, parseQuery } from '$lib/server/query';
import { validNsfwLevels } from '@civitai/shared';
import { updateImageNsfwLevel } from '$lib/server/image-nsfw-level';
import {
  getSweep,
  voteOnTag,
  recordResearchRating,
  recordRatingChange,
  recordTagVoteRatingChange,
  getImageRating,
  SWEEP_LIMITS,
} from '$lib/server/front-page-audit.service';
import {
  getSweepCheckpoints,
  markSweepChecked,
  type SweepCheckpoint,
} from '$lib/server/front-page-timers';
import { DEFAULT_LEVELS, SWEEP_ORDERS, isSweepMedia } from '../sweep';

// `level` is a comma list, and has no default here: the default depends on which tab is open. A bare
// `?level=2` from before multi-select parses to a one-element list, so old links still mean what they did.
const querySchema = z.object({
  level: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map(Number)
        .filter((n) => validNsfwLevels.has(n))
    )
    .catch([]),
  order: z.enum(SWEEP_ORDERS).catch('newest'),
  hours: z.coerce.number().int().min(1).max(720).catch(24),
});

export const load: PageServerLoad = async ({ params, url, locals }) => {
  // The media type is the ROUTE, not a filter: the two sweeps are different populations under
  // different rules — video excludes minors, remixes and anything already queued for review, and pages
  // 20 rows against the image sweep's 200.
  if (!isSweepMedia(params.media)) error(404, 'Unknown sweep');
  const media = params.media;

  const { level, order, hours } = parseQuery(url, querySchema);
  // Per tab, because the tabs are used for different work: the video sweep is the PG patrol this page
  // exists for, and images default to PG-13. Ordered by severity so the heading reads predictably.
  const nsfwLevels = (level.length ? level : DEFAULT_LEVELS[media]).toSorted((a, b) => a - b);

  // The shared resume point wins over the `hours` dropdown when there is one, which is what makes this
  // a queue two moderators can drain together rather than two people re-reading the same rows. An
  // explicit `?hours=` is still honoured — that is someone deliberately looking outside the checkpoint.
  //
  // Both media types have one, and they are separate points (see `checkpointKey`). `reactions` has
  // none: it ranks by popularity rather than time, so `since` is not in force and a checkpoint banner
  // over it would describe a window that does not exist.
  const sharesCheckpoint = order === 'newest';
  const checkpoints = sharesCheckpoint
    ? await getSweepCheckpoints(nsfwLevels, media)
    : new Map<number, SweepCheckpoint>();
  const windowed = new Date(Date.now() - hours * 3600_000);
  const usingCheckpoint =
    sharesCheckpoint && !url.searchParams.has('hours') && checkpoints.size > 0;

  // The OLDEST point across the selected ratings, because one query serves all of them: resuming from
  // the newest would skip everything the ratings behind it have not been swept for. A rating with no
  // point of its own contributes the plain window. Re-showing rows is recoverable; skipping is not.
  const since = usingCheckpoint
    ? new Date(
        Math.min(
          ...nsfwLevels.map((l) => (checkpoints.get(l)?.lastCheckedAt ?? windowed).getTime())
        )
      )
    : windowed;

  const items = await getSweep({ nsfwLevels, order, media, since });

  return {
    nsfwLevels,
    checkpoints: [...checkpoints].map(([level, c]) => ({ level, ...c })),
    order,
    media,
    hours,
    since,
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
  markSwept: async ({ params, request, locals }) => {
    if (!canAccess(locals.user, '/retool/front-page-audit')) return actionFail('Not permitted.');
    // From the route, never the form: which stream this advances decides which population gets skipped,
    // so it is not the client's to claim.
    if (!isSweepMedia(params.media)) return actionFail('Unknown sweep.');
    const username = locals.user.username;
    if (!username) return actionFail('Your account has no username.');

    const input = parseForm(
      z.object({
        nsfwLevel: z
          .string()
          .transform((v) =>
            v
              .split(',')
              .map(Number)
              .filter((n) => validNsfwLevels.has(n))
          )
          .refine((levels) => levels.length > 0, 'Not a rating a sweep can set.'),
        // The `createdAt` of the last row on the page just swept — not `now()`. Anything posted while
        // the moderator worked has not been looked at and must survive into the next window.
        lastCheckedAt: z.coerce.date(),
        order: z.enum(SWEEP_ORDERS),
        // Whether the sweep STARTED from the shared point. Re-derived here rather than trusted: it is
        // the client saying which queue it drained.
        fromCheckpoint: z.string().optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return actionFail(input);
    // Retool disabled Log on the Reaction ordering: it ranks by popularity, not time, so its last row
    // says nothing about how far the queue has been drained and would move the point backwards.
    if (input.order !== 'newest')
      return actionFail('Only the newest-first sweep has a resume point.');

    // 🔴 Advancing the SHARED point from a private window silently discards everything between the two.
    // A moderator on a 24h window whose shared point is five days back would jump it to today and drop
    // four days nobody has looked at, with nothing on screen recording it.
    if (input.fromCheckpoint !== '1')
      return actionFail(
        'This sweep started from your own window, not the shared one — resume the shared sweep before marking it.'
      );

    // One point per rating, advanced independently. A rating already AHEAD of this page's last row is
    // left alone rather than dragged back: the sweep resumed from the oldest of the selected points, so
    // a rating further along was re-shown, not re-swept, and moving it back would re-open work.
    const current = await getSweepCheckpoints(input.nsfwLevel, params.media);
    const behind = input.nsfwLevel.filter((level) => {
      const point = current.get(level);
      return !point || point.lastCheckedAt <= input.lastCheckedAt;
    });
    if (!behind.length)
      return actionFail('Every rating in this sweep is already marked past here. Reload.');

    for (const level of behind)
      await markSweepChecked({
        nsfwLevel: level,
        media: params.media,
        lastCheckedAt: input.lastCheckedAt,
        username,
      });
    return { success: true, swept: input.lastCheckedAt.toISOString(), marked: behind.length };
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

    // BEFORE the vote, for the same reason `setRating` reads it before the update: it is the level the
    // sweep is looking at, which is what Retool recorded as `originalRating`.
    const originalRating = await getImageRating(input.imageId);

    const result = await voteOnTag(input);
    if (!result.ok) return actionFail(result.error ?? 'Could not record that vote.');

    // Retool's LogNsfwLevel2. Additions only — the write itself enforces that.
    if (originalRating !== null)
      await recordTagVoteRatingChange({
        imageId: input.imageId,
        originalRating,
        tagNsfwLevel: result.tagNsfwLevel ?? null,
        direction: input.direction,
        updatedBy: locals.user.username ?? null,
      });

    return { success: true, votedTag: input.tagId };
  },
};
