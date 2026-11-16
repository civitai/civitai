import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import {
  countEvidenceHoldsEnding,
  EVIDENCE_HOLD_ENDING_DAYS,
  GENERATOR_EVIDENCE_HOLD_REASON,
  listEvidenceHeldOwners,
  placeEvidenceHold,
  releaseEvidenceHold,
} from '@civitai/db-queries/evidence-hold';
import { denied, requiresGrant } from '$lib/server/access';
import { dbRead, dbWrite } from '$lib/server/db';
import { recordModActivity } from '$lib/server/mod-activity';
import { int4Id, parseForm, parseQuery } from '$lib/server/query';
import type { Actions, PageServerLoad } from './$types';

const PER_PAGE = 50;

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(500).catch(1),
  ending: z.enum(['1', '0']).optional().catch(undefined),
});

// The page grant alone is not enough: who is held is for csam filers.
export const load: PageServerLoad = async ({ url, locals }) => {
  if (!locals.grants['csam.report.file']) error(403, denied('csam.report.file'));
  const { page, ending } = parseQuery(url, querySchema);
  const { owners: endingCount, earliest } = await countEvidenceHoldsEnding(dbRead);
  // Default to the ending list while anyone is ending, so the badge lands on it.
  const endingOnly = ending === undefined ? endingCount > 0 : ending === '1';
  const offset = (page - 1) * PER_PAGE;
  const { items, hasMore } = await listEvidenceHeldOwners(dbRead, {
    endingOnly,
    limit: PER_PAGE,
    offset,
  });
  return {
    items,
    hasMore,
    page,
    endingOnly,
    endingCount,
    earliest,
    windowDays: EVIDENCE_HOLD_ENDING_DAYS,
    // One timestamp for SSR and hydration, so days-left can't differ between them.
    asOf: Date.now(),
  };
};

const placeSchema = z.object({
  userId: int4Id,
  reason: z
    .string()
    .trim()
    .min(1, 'Give a reason.')
    .max(500)
    .refine(
      (r) => r !== GENERATOR_EVIDENCE_HOLD_REASON,
      'That reason is reserved for generator evidence; describe this hold in your own words.'
    ),
  releaseAt: z
    .union([z.literal(''), z.string().date('Use a date like 2026-12-31.')])
    .optional()
    // Held through the chosen day: the hold ends at the start of the next one, UTC. Erring late keeps evidence.
    .transform((v) => (v ? new Date(Date.parse(`${v}T00:00:00Z`) + 24 * 60 * 60 * 1000) : null))
    .refine((d) => d === null || d.getTime() > Date.now(), 'The end date must be in the future.'),
});

const releaseSchema = z.object({
  holdId: int4Id,
  releaseReason: z.string().trim().min(1, 'Give a reason for releasing.').max(500),
});

export const actions: Actions = {
  place: requiresGrant('csam.report.file', async ({ request, locals }) => {
    const input = parseForm(placeSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'place', error: input });
    const { id, created } = await placeEvidenceHold(dbWrite, {
      ...input,
      role: 'manual',
      createdById: locals.user.id,
    });
    if (created)
      await recordModActivity({
        userId: locals.user.id,
        entityType: 'evidenceHold',
        entityId: id,
        activity: 'placeEvidenceHold',
      });
    return { scope: 'place', holdId: id, created };
  }),
  release: requiresGrant('csam.report.file', async ({ request, locals }) => {
    const input = parseForm(releaseSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'release', error: input });
    const released = await releaseEvidenceHold(dbWrite, {
      id: input.holdId,
      releasedById: locals.user.id,
      releaseReason: input.releaseReason,
    });
    if (!released)
      return fail(409, {
        scope: 'release',
        error:
          'Only an open manual hold, not one kept for a CSAM report or under an extension, can be released here.',
      });
    await recordModActivity({
      userId: locals.user.id,
      entityType: 'evidenceHold',
      entityId: input.holdId,
      activity: 'releaseEvidenceHold',
    });
    return { scope: 'release', holdId: input.holdId };
  }),
};
