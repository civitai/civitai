import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import {
  APPEAL_FILTERS,
  AUDIO_TABS,
  DEFAULT_AUDIO_TAB,
  DISPUTE_FILTERS,
  DISPUTE_STATUSES,
  type DisputeSort,
  HELD_FILTERS,
  type HeldSort,
  isSongRatingLevel,
  type AppealSort,
  REPORTED_FILTERS,
  REPORTED_SORTS,
} from '$lib/audio-review';
import { denied } from '$lib/server/access';
import { songTabCounts } from '$lib/server/audio-review-count';
import {
  boundSongReports,
  canOpenCsamHolds,
  flaggedCoverOf,
  getHeldSongs,
  getReportedSongRows,
  getReportedSongs,
  getSongAppeals,
  getSongDisputes,
  heldStateOf,
  recordHeldDecision,
  isFlaggedSong,
  isSongAppeal,
  songOfDispute,
} from '$lib/server/audio-review.service';
import {
  AppealRestoreRefusedError,
  APPEAL_RESTORE_REFUSED,
  resolveImageAppeal,
} from '$lib/server/image-moderation.service';
import {
  acceptImagesWithReports,
  parseResolutionReason,
  rateImages,
  removeImagesWithReports,
} from '$lib/server/image-queue';
import { logAxiomError } from '$lib/server/axiom';
import { resolveRatingReviewAction } from '$lib/server/rating-review-actions';
import { getSongLinks } from '$lib/server/song-links.service';
import { int4Id, parseForm, parseIdList, parseQueryKeys } from '$lib/server/query';
import { isSong } from '$lib/server/songs';
import { keyed, parseViolation, refuseWithheld } from './actions';

const ACT = 'image.moderate';

// Read key by key: `parseQuery` walks every param, which reruns the load on the selection.
const querySchema = z.object({
  tab: z.enum(AUDIO_TABS).catch(DEFAULT_AUDIO_TAB),
  sort: z.enum(REPORTED_SORTS).catch('oldest'),
  has: z.enum(REPORTED_FILTERS).catch('all'),
  kind: z.enum(APPEAL_FILTERS).catch('all'),
  held: z.enum(HELD_FILTERS).catch('all'),
  ask: z.enum(DISPUTE_FILTERS).catch('all'),
  // Held and Disputes: Pending, Resolved or All (the same values on both).
  status: z.enum(DISPUTE_STATUSES).catch('pending'),
  q: z.string().trim().max(100).catch(''),
  page: z.coerce.number().int().min(1).max(500).catch(1),
  selected: int4Id.optional().catch(undefined),
  // Held and Disputes: one owner's rows (the owner card's links).
  owner: int4Id.optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const { tab, sort, has: filter, q, page, selected, ...parsed } = parseQueryKeys(url, querySchema);
  const user = locals.user;
  const shared = { q, page, canAct: !!locals.grants[ACT], fullBleed: true, headerInline: true };
  // The open tab's badge is its list's own total, under the search.
  if (tab === 'held') {
    const heldSort: HeldSort = sort === 'newest' ? 'newest' : 'oldest';
    const [held, counts] = await Promise.all([
      getHeldSongs({
        sort: heldSort,
        filter: parsed.held,
        q,
        page,
        user,
        owner: parsed.owner,
        status: parsed.status,
      }),
      songTabCounts(),
    ]);
    return {
      tab,
      held: {
        ...held,
        filters: {
          sort: heldSort,
          kind: parsed.held,
          owner: parsed.owner ?? null,
          status: parsed.status,
        },
      },
      // The badge counts what is waiting: a Resolved list is not.
      counts: { ...counts, held: parsed.status === 'pending' ? held.facets.all : counts.held },
      canOpenHolds: canOpenCsamHolds(locals),
      ...shared,
    };
  }
  if (tab === 'appeals') {
    const appealSort: AppealSort = sort === 'newest' ? 'newest' : 'oldest';
    const [appeals, counts] = await Promise.all([
      getSongAppeals({ sort: appealSort, filter: parsed.kind, q, page, user }),
      songTabCounts(),
    ]);
    return {
      tab,
      appeals: { ...appeals, filters: { sort: appealSort, kind: parsed.kind } },
      counts: { ...counts, appeals: appeals.facets.all },
      ...shared,
    };
  }
  if (tab === 'disputes') {
    const disputeSort: DisputeSort = sort === 'newest' ? 'newest' : 'oldest';
    const [disputes, counts] = await Promise.all([
      getSongDisputes({
        sort: disputeSort,
        filter: parsed.ask,
        status: parsed.status,
        q,
        page,
        user,
        owner: parsed.owner,
      }),
      songTabCounts(),
    ]);
    return {
      tab,
      disputes: {
        ...disputes,
        filters: {
          sort: disputeSort,
          ask: parsed.ask,
          status: parsed.status,
          owner: parsed.owner ?? null,
        },
      },
      // The badge counts what is waiting: a Resolved list is not.
      counts: {
        ...counts,
        disputes: parsed.status === 'pending' ? disputes.facets.all : counts.disputes,
      },
      ...shared,
    };
  }
  const [result, counts] = await Promise.all([
    getReportedSongs({ sort, filter, q, page, user }),
    songTabCounts(),
  ]);
  // A deep link opens its song even when the filters or paging leave it off this page.
  const pinned =
    selected && !result.items.some((r) => r.id === selected)
      ? (await getReportedSongRows([selected], user))[0] ?? null
      : null;
  return {
    tab,
    reported: { ...result, pinned },
    counts: { ...counts, reported: result.facets.all },
    filters: { tab, sort, filter },
    ...shared,
  };
};

function gated<E extends RequestEvent, R>(handler: (event: E) => R) {
  return (event: E) =>
    event.locals.grants[ACT] ? handler(event) : fail(403, { error: denied(ACT) });
}

const decisionSchema = z.object({
  imageId: int4Id,
  reportIds: z.string().transform((v) => parseIdList(v)),
});

const NO_PENDING_REPORTS =
  'Its reports were already closed, or are not on this song. Nothing was changed. Reload.';

/** The song a decision names and the reports it closes: the posted ones still Pending on it. */
async function songDecision(form: FormData) {
  const input = parseForm(decisionSchema, form);
  if (typeof input === 'string') return fail(400, { error: input });
  const reportIds = await boundSongReports(input.imageId, input.reportIds);
  if (!reportIds.length) return fail(409, { error: NO_PENDING_REPORTS, key: input.imageId });
  return { imageId: input.imageId, reportIds };
}

const writerForm = (fields: Record<string, string | number | undefined>) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields))
    if (value !== undefined) form.set(key, String(value));
  return form;
};

export const actions: Actions = {
  dismiss: gated(async (event) => {
    const decision = await songDecision(await event.request.formData());
    if ('status' in decision) return decision;
    return acceptImagesWithReports(
      writerForm({ imageIds: decision.imageId, reportIds: decision.reportIds.join(',') }),
      event.locals
    );
  }),

  remove: gated(async (event) => {
    const form = await event.request.formData();
    const decision = await songDecision(form);
    if ('status' in decision) return decision;
    const violation = parseViolation(form, decision.imageId);
    if ('status' in violation) return violation;
    return removeImagesWithReports(
      writerForm({
        imageIds: decision.imageId,
        reportIds: decision.reportIds.join(','),
        violationType: violation.violationType,
        violationDetails: violation.violationDetails,
      }),
      event
    );
  }),

  // A correction, not a verdict: the reports stay open.
  setRating: gated(async (event) => {
    const input = parseForm(
      z.object({ imageId: int4Id, nsfwLevel: z.coerce.number().int() }),
      await event.request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    const { imageId, nsfwLevel } = input;
    if (!isSongRatingLevel(nsfwLevel))
      return fail(400, { error: 'A song is rated PG to XXX.', key: imageId });
    if (!(await isSong(imageId))) return fail(404, { error: 'Not a song.', key: imageId });
    return keyed(
      await rateImages(writerForm({ imageIds: imageId, nsfwLevel }), event.locals),
      imageId
    );
  }),

  // Removes only the song's own cover, with its own violation type: the song stays public with the
  // placeholder, and its reports stay open (they are on the song). Image reports' removal writer, on
  // the cover's row, and only while it is the cover the page showed (`coverId`).
  removeCover: gated(async (event) => {
    const form = await event.request.formData();
    const input = parseForm(z.object({ imageId: int4Id, coverId: int4Id }), form);
    if (typeof input === 'string') return fail(400, { error: input });
    const songId = input.imageId;
    const violation = parseViolation(form, songId);
    if ('status' in violation) return violation;
    const withheld = await refuseWithheld(event.locals.user, songId, songId);
    if (withheld) return withheld;
    const held = await heldBefore(event, songId);
    // Read here, not through `visibleSongLinks`, which turns a failed read or a withheld cover into
    // "no cover": each gets its own answer (a withheld cover is refused by the removal writer).
    let coverId: number | null | undefined;
    try {
      coverId = (await getSongLinks([songId])).get(songId)?.songCoverId;
    } catch (error) {
      logAxiomError(error, { name: 'audio-review-remove-cover' });
      return fail(503, { error: "Couldn't check the cover. Try again.", key: songId });
    }
    if (coverId == null)
      return fail(409, { error: 'This song has no cover to remove. Reload.', key: songId });
    if (coverId !== input.coverId) return fail(409, { error: NEW_COVER, key: songId });
    const result = await removeImagesWithReports(
      writerForm({ imageIds: coverId, ...violation }),
      event
    );
    if ('status' in result) return fail(result.status, { ...result.data, key: songId });
    await recordHeldRemoval(event, songId, held, 'removeCover', result, coverId);
    return { ...result, coverId, key: songId };
  }),

  removeSong: gated(async (event) => {
    const form = await event.request.formData();
    const input = parseForm(z.object({ imageId: int4Id }), form);
    if (typeof input === 'string') return fail(400, { error: input });
    const songId = input.imageId;
    const violation = parseViolation(form, songId);
    if ('status' in violation) return violation;
    if (!(await isSong(songId))) return fail(404, { error: 'Not a song.', key: songId });
    const held = await heldBefore(event, songId);
    const result = await removeImagesWithReports(
      writerForm({ imageIds: songId, ...violation }),
      event
    );
    if (!('status' in result))
      await recordHeldRemoval(event, songId, held, 'removeSong', result, held?.coverId ?? null);
    return keyed(result, songId);
  }),

  approveCover: gated((event) => approveHeld(event, 'cover')),
  approveSong: gated((event) => approveHeld(event, 'song')),

  approveAppeal: gated((event) => decideAppeal(event, 'Approved')),
  rejectAppeal: gated((event) => decideAppeal(event, 'Rejected')),

  // Rules through the rating-review resolver with songs: true, the only caller allowed to resolve a
  // song dispute.
  resolveDispute: gated(async (event) => {
    const input = parseForm(disputeSchema, await event.request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const { reviewId } = input;
    const songId = await songOfDispute(reviewId);
    if (songId == null)
      return fail(409, {
        error: 'This dispute was already decided, or is not on a song. Reload.',
        key: reviewId,
      });
    const withheld = await refuseWithheld(event.locals.user, songId, reviewId);
    if (withheld) return withheld;
    const result = await resolveRatingReviewAction({
      ...input,
      userId: event.locals.user.id,
      songs: true,
    });
    if (!result.ok) return fail(409, { error: result.error, key: reviewId });
    return { success: true, status: result.status, key: reviewId };
  }),
};

const disputeSchema = z.object({
  reviewId: int4Id,
  appliedLevel: z.coerce.number().int().positive(),
  modComment: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((v) => v || undefined),
});

const NEW_COVER = 'This song has a new cover since this page loaded. Nothing was changed. Reload.';

const NOT_HELD = {
  cover: 'This song has no cover under review any more. Nothing was changed. Reload.',
  song: 'This song is no longer held for review. Nothing was changed. Reload.',
};

/** Approve cover or Approve song: the image's review flag cleared, only while it is the flag the
 *  page showed (`needsReview`) and one the Held tab decides; a cover also only while it is the cover
 *  the page showed (`coverId`), since the owner can replace it with one flagged the same. */
async function approveHeld(event: RequestEvent, kind: 'cover' | 'song') {
  const form = await event.request.formData();
  const input = parseForm(
    z.object({
      imageId: int4Id,
      needsReview: z.string().max(40),
      coverId: kind === 'cover' ? int4Id : int4Id.optional(),
    }),
    form
  );
  if (typeof input === 'string') return fail(400, { error: input });
  const { imageId: songId, needsReview } = input;
  const withheld = await refuseWithheld(event.locals.user, songId, songId);
  if (withheld) return withheld;
  const target =
    kind === 'cover'
      ? await flaggedCoverOf(songId, needsReview)
      : (await isFlaggedSong(songId, needsReview))
      ? songId
      : null;
  if (target == null) return fail(409, { error: NOT_HELD[kind], key: songId });
  if (kind === 'cover' && target !== input.coverId)
    return fail(409, { error: NEW_COVER, key: songId });
  const result = await acceptImagesWithReports(
    writerForm({
      imageIds: target,
      needsReviewByImage: JSON.stringify({ [target]: needsReview }),
    }),
    event.locals
  );
  if (!('status' in result))
    await recordHeldDecision({
      userId: event.locals.user.id,
      songId,
      decision: kind === 'cover' ? 'approveCover' : 'approveSong',
      held: { kind, flag: needsReview },
      coverId: kind === 'cover' ? target : null,
    });
  return keyed(result, songId);
}

/** What holds the song, read before a removal posted from the Held tab; null from any other tab. */
const heldBefore = (event: RequestEvent, songId: number) =>
  event.url.searchParams.get('tab') === 'held' ? heldStateOf(songId) : Promise.resolve(null);

/** A removal on the Held tab, once it went through: not one held for a second moderator. */
async function recordHeldRemoval(
  event: RequestEvent,
  songId: number,
  held: Awaited<ReturnType<typeof heldStateOf>>,
  decision: 'removeCover' | 'removeSong',
  result: { held?: unknown },
  coverId: number | null
) {
  if (!held || typeof result.held === 'string') return;
  await recordHeldDecision({ userId: event.locals.user.id, songId, decision, held, coverId });
}

async function decideAppeal(event: RequestEvent, status: 'Approved' | 'Rejected') {
  const form = await event.request.formData();
  const input = parseForm(z.object({ imageId: int4Id }), form);
  if (typeof input === 'string') return fail(400, { error: input });
  const { imageId } = input;
  const reason = parseResolutionReason(form, status);
  if (typeof reason === 'string') return fail(400, { error: reason, key: imageId });
  const withheld = await refuseWithheld(event.locals.user, imageId, imageId);
  if (withheld) return withheld;
  if (!(await isSongAppeal(imageId)))
    return fail(409, {
      error: 'This appeal was already decided, or is not on a song or its cover. Reload.',
      key: imageId,
    });
  const resolvedMessage =
    String(form.get('resolvedMessage') ?? '')
      .trim()
      .slice(0, 1000) || undefined;
  try {
    const closed = await resolveImageAppeal({
      imageId,
      status,
      resolvedMessage,
      ...reason,
      userId: event.locals.user.id,
    });
    if (!closed)
      return fail(409, {
        error: 'Another moderator already resolved this appeal. Reload.',
        key: imageId,
      });
  } catch (e) {
    if (e instanceof AppealRestoreRefusedError)
      return fail(409, { error: APPEAL_RESTORE_REFUSED, key: imageId });
    throw e;
  }
  return { success: true, key: imageId };
}
