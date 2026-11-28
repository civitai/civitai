import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { denied, requiresGrant } from '$lib/server/access';
import {
  CSAM_HOLD_SORTS,
  CSAM_HOLD_STATUSES,
  DEFAULT_CSAM_HOLD_FILTERS,
  type CsamHoldFilters,
} from '$lib/csam-holds/hold-filters';
import {
  countCsamHoldsByType,
  countPendingCsamHolds,
  csamHoldSearch,
  decideAuthorHolds,
  decideCsamHold,
  getCleanRescans,
  getHoldCoverImages,
  listCsamHolds,
  markCsamHoldReported,
  setCsamHoldReportChoice,
  referCsamHold,
  type CsamHoldCovers,
} from '$lib/server/csam-holds.service';
import { CSAM_REPORT_CHOICES } from '$lib/csam-holds/report-choice';
import { int4Id, jsonField, parseForm, parseQuery } from '$lib/server/query';
import { withheldImageIds } from '$lib/server/retracted-media';
import type { Actions, PageServerLoad } from './$types';
import { ALSO_MAX } from './hold-author';
import type { HoldContext } from './hold-context';
import { getHoldContexts, withheldHoldMedia } from './hold-context.server';
import {
  CSAM_HOLD_DECISION_GRANTS,
  CSAM_HOLD_DECISIONS,
  CSAM_HOLD_ENTITY_TYPES,
  NOTE_MAX_LENGTH,
} from './hold-entity';

const querySchema = z.object({
  limit: z.coerce.number().int().min(10).max(200).catch(50),
  page: z.coerce.number().int().min(1).max(500).catch(1),
  entityType: z.enum(CSAM_HOLD_ENTITY_TYPES).optional().catch(undefined),
  status: z.enum(CSAM_HOLD_STATUSES).catch(DEFAULT_CSAM_HOLD_FILTERS.status),
  sort: z.enum(CSAM_HOLD_SORTS).catch(DEFAULT_CSAM_HOLD_FILTERS.sort),
  q: z.string().trim().max(100).catch(''),
  author: int4Id.optional().catch(undefined),
});

// The page grant only decides who sees the nav entry and badge; the held text is for csam filers.
export const load: PageServerLoad = async ({ url, locals }) => {
  if (!locals.grants['csam.report.file']) error(403, denied('csam.report.file'));
  const { limit, page, entityType, status, sort, q, author } = parseQuery(url, querySchema);
  const offset = (page - 1) * limit;
  const search = csamHoldSearch(q);
  const holdFilters: CsamHoldFilters = { status, sort };
  const [queue, byType, pendingCount] = await Promise.all([
    listCsamHolds({ limit, offset, entityType, status, sort, search, author }),
    // The chip counts and the footer's "of N" are decoration; a failure here must not take the list down with it.
    countCsamHoldsByType({ status, search, author }).catch((err) => {
      console.error('CSAM hold counts failed', err);
      return null;
    }),
    // The status control's badge: every pending hold, whatever the list is narrowed to.
    countPendingCsamHolds().catch((err) => {
      console.error('CSAM pending count failed', err);
      return null;
    }),
  ]);
  // Images are decoration: a failure leaves the rows on their icons and the details without a preview.
  const covers = await getHoldCoverImages(queue.items).catch((err) => {
    console.error('CSAM hold images failed', err);
    return new Map<number, CsamHoldCovers>();
  });
  // Profile and comment-parent context is decoration too; its loader already degrades per kind.
  const contexts = await getHoldContexts(queue.items, {
    withheld: (ids) => withheldImageIds(locals.user, ids),
  }).catch((err) => {
    console.error('CSAM hold context failed', err);
    return new Map<number, HoldContext>();
  });
  // Also decoration: a failed read just leaves the "edited since" line off.
  const cleanRescans = await getCleanRescans(queue.items).catch((err) => {
    console.error('CSAM hold rescans failed', err);
    return new Map<number, Date>();
  });
  const items = await withheldHoldMedia(
    queue.items.map((hold) => ({
      ...hold,
      cleanRescanAt: cleanRescans.get(hold.id) ?? null,
      coverImages: covers.get(hold.id)?.images ?? [],
      imageTotal: covers.get(hold.id)?.total ?? 0,
      profile: contexts.get(hold.id)?.profile ?? null,
      parent: contexts.get(hold.id)?.parent ?? null,
      song: contexts.get(hold.id)?.song ?? null,
      songWithheld: contexts.get(hold.id)?.songWithheld ?? false,
      songUnavailable: contexts.get(hold.id)?.songUnavailable ?? false,
    })),
    locals.user
  );
  const typeCounts: Record<string, number> | null = byType && {
    ...byType,
    all: Object.values(byType).reduce((sum, n) => sum + n, 0),
  };
  const total = typeCounts ? typeCounts[entityType ?? 'all'] ?? 0 : undefined;
  return {
    limit,
    page,
    offset,
    q,
    author: author ?? null,
    entityType: entityType ?? null,
    holdFilters,
    typeCounts,
    pendingCount,
    total,
    items,
    hasMore: queue.hasMore,
    fullBleed: true,
    headerInline: true,
  };
};

const alsoSchema = z
  .array(z.object({ holdId: int4Id, textHash: z.string().min(1).max(200) }))
  .max(ALSO_MAX);

const noteField = z
  .string()
  .trim()
  .max(NOTE_MAX_LENGTH, `The note is longer than ${NOTE_MAX_LENGTH} characters.`)
  .optional()
  .transform((v) => v || undefined);

const decideSchema = z
  .object({
    holdId: int4Id,
    textHash: z.string().min(1).max(200),
    decision: z.enum(CSAM_HOLD_DECISIONS),
    reportChoice: z.enum(CSAM_REPORT_CHOICES).optional(),
    also: jsonField(alsoSchema).optional(),
    note: noteField,
  })
  .refine((input) => input.decision === 'dismiss' || input.reportChoice !== undefined, {
    message: 'Pick a report category, or None of these.',
  })
  .refine((input) => input.decision !== 'remove_ban_report' || input.reportChoice !== 'none', {
    message: 'Filing a report needs a reportable category.',
  })
  .transform((input) =>
    input.decision === 'dismiss' ? { ...input, reportChoice: undefined } : input
  );

const markReportedSchema = z.object({
  holdId: int4Id,
  included: z.enum(['true', 'false']).transform((v) => v === 'true'),
});

const setReportChoiceSchema = z.object({
  holdId: int4Id,
  reportChoice: z.enum(CSAM_REPORT_CHOICES),
});

const referSchema = z.object({
  holdId: int4Id,
  textHash: z.string().min(1).max(200),
  note: noteField,
});

export const actions: Actions = {
  decide: requiresGrant('csam.report.file', async ({ request, locals }) => {
    const input = parseForm(decideSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });

    const needed = CSAM_HOLD_DECISION_GRANTS[input.decision];
    if (needed && !locals.grants[needed])
      return fail(403, { scope: 'denied' as const, error: denied(needed), key: input.holdId });

    const { also, ...primary } = input;
    const result = await decideCsamHold(primary);
    if (!result.ok) return fail(400, { error: result.error, key: input.holdId });
    const others = also?.length
      ? await decideAuthorHolds({
          holdId: input.holdId,
          also,
          decision: input.decision,
          note: input.note,
        }).catch((err) => {
          console.error('CSAM hold bulk decision failed', err);
          return also.map(({ holdId }) => ({
            holdId,
            ok: false,
            error: 'Could not apply the decision to this hold.',
          }));
        })
      : undefined;
    return { success: true, key: input.holdId, ...(others ? { others } : {}) };
  }),
  refer: requiresGrant('csam.report.file', async ({ request }) => {
    const input = parseForm(referSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const result = await referCsamHold(input);
    if (!result.ok) return fail(400, { error: result.error, key: input.holdId });
    return { success: true, key: input.holdId, referred: true };
  }),
  setReportChoice: requiresGrant('csam.report.file', async ({ request }) => {
    const input = parseForm(setReportChoiceSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const result = await setCsamHoldReportChoice(input);
    if (!result.ok) return fail(400, { error: result.error, key: input.holdId });
    return { success: true, key: input.holdId, reportChoice: input.reportChoice };
  }),
  markReported: requiresGrant('csam.report.file', async ({ request }) => {
    const input = parseForm(markReportedSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const result = await markCsamHoldReported(input);
    if (!result.ok) return fail(400, { error: result.error, key: input.holdId });
    return { success: true, key: input.holdId, reportIncluded: input.included };
  }),
};
