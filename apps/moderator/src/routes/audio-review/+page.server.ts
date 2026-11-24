import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import {
  APPEAL_FILTERS,
  AUDIO_TABS,
  DEFAULT_AUDIO_TAB,
  isSongRatingLevel,
  LIVE_AUDIO_TABS,
  type AppealSort,
  REPORTED_FILTERS,
  REPORTED_SORTS,
} from '$lib/audio-review';
import { denied } from '$lib/server/access';
import { countReportedSongs, countSongAppeals } from '$lib/server/audio-review-count';
import {
  boundSongReports,
  getReportedSongRows,
  getReportedSongs,
  getSongAppeals,
  isSongAppeal,
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
import { getSongLinks } from '$lib/server/song-links.service';
import { int4Id, parseForm, parseIdList, parseQueryKeys } from '$lib/server/query';
import { violationInputSchema } from '$lib/violations';

// Audio review: songs on the shared triage shell (docs/features/music.md "Moderating songs"). The
// Reported tab works on Image reports' data, so its decisions are Image reports' own writers
// (`$lib/server/image-queue.ts`) on one song and the reports shown for it, behind the same
// `image.moderate` action grant. Reaching the page is its own page grant.
const ACT = 'image.moderate';

// Read key by key: `parseQuery` walks every param, which reruns the load on the selection.
const querySchema = z.object({
  tab: z.enum(AUDIO_TABS).catch(DEFAULT_AUDIO_TAB),
  sort: z.enum(REPORTED_SORTS).catch('oldest'),
  has: z.enum(REPORTED_FILTERS).catch('all'),
  kind: z.enum(APPEAL_FILTERS).catch('all'),
  q: z.string().trim().max(100).catch(''),
  page: z.coerce.number().int().min(1).max(500).catch(1),
  selected: int4Id.optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const parsed = parseQueryKeys(url, querySchema);
  // The other tabs arrive later on this page; until then they open the Reported tab.
  const tab = LIVE_AUDIO_TABS.includes(parsed.tab) ? parsed.tab : DEFAULT_AUDIO_TAB;
  const { sort, has: filter, q, page, selected } = parsed;
  const canAct = !!locals.grants[ACT];
  if (tab === 'appeals') {
    const appealSort: AppealSort = sort === 'newest' ? 'newest' : 'oldest';
    const [appeals, reported] = await Promise.all([
      getSongAppeals({ sort: appealSort, filter: parsed.kind, q, page, user: locals.user }),
      countReportedSongs(),
    ]);
    return {
      tab,
      appeals: { ...appeals, filters: { sort: appealSort, kind: parsed.kind } },
      counts: { reported: reported.songs, appeals: appeals.facets.all },
      q,
      page,
      canAct,
      fullBleed: true,
      headerInline: true,
    };
  }
  const [result, appealCount] = await Promise.all([
    getReportedSongs({ sort, filter, q, page, user: locals.user }),
    countSongAppeals(),
  ]);
  // A deep link opens its song even when the filters or paging leave it off this page.
  const pinned =
    selected && !result.items.some((r) => r.id === selected)
      ? (await getReportedSongRows([selected], locals.user))[0] ?? null
      : null;
  return {
    tab,
    reported: { ...result, pinned },
    counts: { reported: result.facets.all, appeals: appealCount },
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
  // the cover's row.
  removeCover: gated(async (event) => {
    const form = await event.request.formData();
    const input = parseForm(z.object({ imageId: int4Id }), form);
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

  // An owner's appeal of a removed song or cover, through the image appeal resolver: approving
  // restores only the image appealed (a cover leaves its song alone and the reverse), rejecting keeps
  // it removed with the reason recorded and the owner told.
  approveAppeal: gated((event) => decideAppeal(event, 'Approved')),
  rejectAppeal: gated((event) => decideAppeal(event, 'Rejected')),
};

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
