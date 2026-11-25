import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import {
  APPEAL_FILTERS,
  AUDIO_TABS,
  DEFAULT_AUDIO_TAB,
  DISPUTE_FILTERS,
  type DisputeSort,
  HELD_FILTERS,
  type HeldSort,
  isSongRatingLevel,
  LIVE_AUDIO_TABS,
  type AppealSort,
  REPORTED_FILTERS,
  REPORTED_SORTS,
} from '$lib/audio-review';
import { canAccess, denied } from '$lib/server/access';
import {
  countHeldSongs,
  countReportedSongs,
  countSongAppeals,
  countSongDisputes,
} from '$lib/server/audio-review-count';
import {
  boundSongReports,
  flaggedCoverOf,
  getHeldSongs,
  getReportedSongRows,
  getReportedSongs,
  getSongAppeals,
  getSongDisputes,
  isFlaggedSong,
  isSongAppeal,
  songOfDispute,
} from '$lib/server/audio-review.service';
import {
  AppealRestoreRefusedError,
  APPEAL_RESTORE_REFUSED,
  resolveImageAppeal,
} from '$lib/server/image-moderation.service';
import { dbRead } from '$lib/server/db';
import {
  acceptImagesWithReports,
  parseResolutionReason,
  rateImages,
  removeImagesWithReports,
} from '$lib/server/image-queue';
import { withheldRefusal } from '$lib/server/retracted-media';
import { logAxiomError } from '$lib/server/axiom';
import { resolveRatingReviewAction } from '$lib/server/rating-review-actions';
import { getSongLinks } from '$lib/server/song-links.service';
import { int4Id, parseForm, parseIdList, parseQueryKeys } from '$lib/server/query';
import { violationInputSchema } from '$lib/violations';

// Audio review: songs on the shared triage shell (docs/features/music.md "Moderating songs"). The
// Reported tab works on Image reports' data, so its decisions are Image reports' own writers
// (`$lib/server/image-queue.ts`) on one song and the reports shown for it, behind the same
// `image.moderate` action grant. Reaching the page is its own page grant.
const ACT = 'image.moderate';
// A lyrics hold is decided in CSAM holds, whose page refuses to load without this grant.
const CSAM_HOLDS = '/csam/text-holds';
const CSAM_HOLDS_GRANT = 'csam.report.file';

// Read key by key: `parseQuery` walks every param, which reruns the load on the selection.
const querySchema = z.object({
  tab: z.enum(AUDIO_TABS).catch(DEFAULT_AUDIO_TAB),
  sort: z.enum(REPORTED_SORTS).catch('oldest'),
  has: z.enum(REPORTED_FILTERS).catch('all'),
  kind: z.enum(APPEAL_FILTERS).catch('all'),
  held: z.enum(HELD_FILTERS).catch('all'),
  ask: z.enum(DISPUTE_FILTERS).catch('all'),
  q: z.string().trim().max(100).catch(''),
  page: z.coerce.number().int().min(1).max(500).catch(1),
  selected: int4Id.optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const parsed = parseQueryKeys(url, querySchema);
  // A tab not yet live on this page opens the Reported tab.
  const tab = LIVE_AUDIO_TABS.includes(parsed.tab) ? parsed.tab : DEFAULT_AUDIO_TAB;
  const { sort, has: filter, q, page, selected } = parsed;
  const canAct = !!locals.grants[ACT];
  // Every held row, lyrics holds included, as the tab lists them.
  const heldCount = () => countHeldSongs().then(({ lyrics, actionable }) => lyrics + actionable);
  if (tab === 'held') {
    const heldSort: HeldSort = sort === 'newest' ? 'newest' : 'oldest';
    const [held, reported, appealCount, disputes] = await Promise.all([
      getHeldSongs({ sort: heldSort, filter: parsed.held, q, page, user: locals.user }),
      countReportedSongs(),
      countSongAppeals(),
      countSongDisputes(),
    ]);
    return {
      tab,
      held: { ...held, filters: { sort: heldSort, kind: parsed.held } },
      counts: { reported: reported.songs, appeals: appealCount, held: held.facets.all, disputes },
      canOpenHolds: canAccess(locals.user, CSAM_HOLDS) && !!locals.grants[CSAM_HOLDS_GRANT],
      q,
      page,
      canAct,
      fullBleed: true,
      headerInline: true,
    };
  }
  if (tab === 'appeals') {
    const appealSort: AppealSort = sort === 'newest' ? 'newest' : 'oldest';
    const [appeals, reported, held, disputes] = await Promise.all([
      getSongAppeals({ sort: appealSort, filter: parsed.kind, q, page, user: locals.user }),
      countReportedSongs(),
      heldCount(),
      countSongDisputes(),
    ]);
    return {
      tab,
      appeals: { ...appeals, filters: { sort: appealSort, kind: parsed.kind } },
      counts: { reported: reported.songs, appeals: appeals.facets.all, held, disputes },
      q,
      page,
      canAct,
      fullBleed: true,
      headerInline: true,
    };
  }
  if (tab === 'disputes') {
    const disputeSort: DisputeSort = sort === 'newest' ? 'newest' : 'oldest';
    const [disputes, reported, appealCount, held] = await Promise.all([
      getSongDisputes({ sort: disputeSort, filter: parsed.ask, q, page, user: locals.user }),
      countReportedSongs(),
      countSongAppeals(),
      heldCount(),
    ]);
    return {
      tab,
      disputes: { ...disputes, filters: { sort: disputeSort, ask: parsed.ask } },
      counts: {
        reported: reported.songs,
        appeals: appealCount,
        held,
        disputes: disputes.facets.all,
      },
      q,
      page,
      canAct,
      fullBleed: true,
      headerInline: true,
    };
  }
  const [result, appealCount, heldTotal, disputeCount] = await Promise.all([
    getReportedSongs({ sort, filter, q, page, user: locals.user }),
    countSongAppeals(),
    heldCount(),
    countSongDisputes(),
  ]);
  // A deep link opens its song even when the filters or paging leave it off this page.
  const pinned =
    selected && !result.items.some((r) => r.id === selected)
      ? (await getReportedSongRows([selected], locals.user))[0] ?? null
      : null;
  return {
    tab,
    reported: { ...result, pinned },
    counts: {
      reported: result.facets.all,
      appeals: appealCount,
      held: heldTotal,
      disputes: disputeCount,
    },
    filters: { tab, sort, filter },
    q,
    page,
    canAct,
    fullBleed: true,
    headerInline: true,
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
  // Image reports' Unaction: the song accepted, its reports closed as Unactioned.
  dismiss: gated(async (event) => {
    const decision = await songDecision(await event.request.formData());
    if ('status' in decision) return decision;
    return acceptImagesWithReports(
      writerForm({ imageIds: decision.imageId, reportIds: decision.reportIds.join(',') }),
      event.locals
    );
  }),

  // Image reports' removal, with its violation type, required here: the owner is told why.
  remove: gated(async (event) => {
    const form = await event.request.formData();
    const decision = await songDecision(form);
    if ('status' in decision) return decision;
    const violation = parseForm(violationInputSchema, form);
    if (typeof violation === 'string')
      return fail(400, { error: violation, key: decision.imageId });
    if (!violation.violationType)
      return fail(400, { error: 'Pick a violation type.', key: decision.imageId });
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

  // A correction, not a verdict: the reports stay open. The writer refuses a song its own scans have
  // not reviewed (`updateImageNsfwLevel`).
  setRating: gated(async (event) => {
    const input = parseForm(
      z.object({ imageId: int4Id, nsfwLevel: z.coerce.number().int() }),
      await event.request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    const { imageId, nsfwLevel } = input;
    if (!isSongRatingLevel(nsfwLevel))
      return fail(400, { error: 'A song is rated PG to XXX.', key: imageId });
    const song = await dbRead
      .selectFrom('Image')
      .select('id')
      .where('id', '=', imageId)
      .where('type', '=', 'audio')
      .executeTakeFirst();
    if (!song) return fail(404, { error: 'Not a song.', key: imageId });
    const result = await rateImages(writerForm({ imageIds: imageId, nsfwLevel }), event.locals);
    return 'status' in result ? fail(result.status, { ...result.data, key: imageId }) : result;
  }),

  // Removes only the song's own cover, with its own violation type: the song stays public with the
  // placeholder, and its reports stay open (they are on the song). Image reports' removal writer, on
  // the cover's row, and only while it is the cover the page showed (`coverId`).
  removeCover: gated(async (event) => {
    const form = await event.request.formData();
    const input = parseForm(z.object({ imageId: int4Id, coverId: int4Id }), form);
    if (typeof input === 'string') return fail(400, { error: input });
    const songId = input.imageId;
    const violation = parseForm(violationInputSchema, form);
    if (typeof violation === 'string') return fail(400, { error: violation, key: songId });
    if (!violation.violationType)
      return fail(400, { error: 'Pick a violation type.', key: songId });
    const withheld = await withheldRefusal(event.locals.user, [songId]);
    if (withheld) return fail(403, { error: withheld, key: songId });
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
      writerForm({
        imageIds: coverId,
        violationType: violation.violationType,
        violationDetails: violation.violationDetails,
      }),
      event
    );
    return 'status' in result
      ? fail(result.status, { ...result.data, key: songId })
      : { ...result, coverId, key: songId };
  }),

  // Held tab: a song removed with its violation type, with no reports to close (Image reports'
  // removal writer, as Remove song on the Reported tab).
  removeSong: gated(async (event) => {
    const form = await event.request.formData();
    const input = parseForm(z.object({ imageId: int4Id }), form);
    if (typeof input === 'string') return fail(400, { error: input });
    const songId = input.imageId;
    const violation = parseForm(violationInputSchema, form);
    if (typeof violation === 'string') return fail(400, { error: violation, key: songId });
    if (!violation.violationType)
      return fail(400, { error: 'Pick a violation type.', key: songId });
    if (!(await isSong(songId))) return fail(404, { error: 'Not a song.', key: songId });
    const result = await removeImagesWithReports(
      writerForm({
        imageIds: songId,
        violationType: violation.violationType,
        violationDetails: violation.violationDetails,
      }),
      event
    );
    return 'status' in result
      ? fail(result.status, { ...result.data, key: songId })
      : { ...result, key: songId };
  }),

  // Held tab: the song's own cover accepted from its review flag, through the review queues' accept
  // writer on the cover's row alone. The song is not touched.
  approveCover: gated((event) => approveHeld(event, 'cover')),
  // Held tab: a song flagged for review itself, accepted from that flag the same way.
  approveSong: gated((event) => approveHeld(event, 'song')),

  // An owner's appeal of a removed song or cover, through the image appeal resolver: approving
  // restores only the image appealed (a cover leaves its song alone and the reverse), rejecting keeps
  // it removed with the reason recorded and the owner told.
  approveAppeal: gated((event) => decideAppeal(event, 'Approved')),
  rejectAppeal: gated((event) => decideAppeal(event, 'Rejected')),

  // An owner's rating dispute on a song, ruled through the moderator rating-review resolver (the one
  // /ratings uses, which leaves song disputes to this page): applying the owner's ask approves it and
  // anything else rejects it, keeping the rating needs a reason, the level is written only to a song
  // its own scans reviewed, and the owner is told.
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
    const withheld = await withheldRefusal(event.locals.user, [songId]);
    if (withheld) return fail(403, { error: withheld, key: reviewId });
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

async function isSong(imageId: number) {
  const song = await dbRead
    .selectFrom('Image')
    .select('id')
    .where('id', '=', imageId)
    .where('type', '=', 'audio')
    .executeTakeFirst();
  return !!song;
}

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
  const withheld = await withheldRefusal(event.locals.user, [songId]);
  if (withheld) return fail(403, { error: withheld, key: songId });
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
    writerForm({ imageIds: target, needsReviewByImage: JSON.stringify({ [target]: needsReview }) }),
    event.locals
  );
  return 'status' in result
    ? fail(result.status, { ...result.data, key: songId })
    : { ...result, key: songId };
}

async function decideAppeal(event: RequestEvent, status: 'Approved' | 'Rejected') {
  const form = await event.request.formData();
  const input = parseForm(z.object({ imageId: int4Id }), form);
  if (typeof input === 'string') return fail(400, { error: input });
  const { imageId } = input;
  const reason = parseResolutionReason(form, status);
  if (typeof reason === 'string') return fail(400, { error: reason, key: imageId });
  const withheld = await withheldRefusal(event.locals.user, [imageId]);
  if (withheld) return fail(403, { error: withheld, key: imageId });
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
