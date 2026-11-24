import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import {
  AUDIO_TABS,
  DEFAULT_AUDIO_TAB,
  isSongRatingLevel,
  LIVE_AUDIO_TABS,
  REPORTED_FILTERS,
  REPORTED_SORTS,
} from '$lib/audio-review';
import { denied } from '$lib/server/access';
import {
  boundSongReports,
  getReportedSongRows,
  getReportedSongs,
} from '$lib/server/audio-review.service';
import { dbRead } from '$lib/server/db';
import {
  acceptImagesWithReports,
  rateImages,
  removeImagesWithReports,
} from '$lib/server/image-queue';
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
  q: z.string().trim().max(100).catch(''),
  page: z.coerce.number().int().min(1).max(500).catch(1),
  selected: int4Id.optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const parsed = parseQueryKeys(url, querySchema);
  // The other tabs arrive later on this page; until then they open the Reported tab.
  const tab = LIVE_AUDIO_TABS.includes(parsed.tab) ? parsed.tab : DEFAULT_AUDIO_TAB;
  const { sort, has: filter, q, page, selected } = parsed;
  const result = await getReportedSongs({ sort, filter, q, page, user: locals.user });
  // A deep link opens its song even when the filters or paging leave it off this page.
  const pinned =
    selected && !result.items.some((r) => r.id === selected)
      ? (await getReportedSongRows([selected], locals.user))[0] ?? null
      : null;
  return {
    ...result,
    pinned,
    filters: { tab, sort, filter },
    q,
    page,
    canAct: !!locals.grants[ACT],
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
};
