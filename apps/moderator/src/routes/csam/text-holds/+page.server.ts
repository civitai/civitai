import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { denied, requiresGrant } from '$lib/server/access';
import {
  countPendingCsamHolds,
  decideCsamHold,
  listPendingCsamHolds,
} from '$lib/server/csam-holds.service';
import { int4Id, parseForm, parseQuery } from '$lib/server/query';
import type { Actions, PageServerLoad } from './$types';
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
});

// The page grant only decides who sees the nav entry and badge; the held text is for csam filers.
export const load: PageServerLoad = async ({ url, locals }) => {
  if (!locals.grants['csam.report.file']) error(403, denied('csam.report.file'));
  const { limit, page, entityType } = parseQuery(url, querySchema);
  const offset = (page - 1) * limit;
  const [queue, total] = await Promise.all([
    listPendingCsamHolds({ limit, offset, entityType }),
    // The footer's "of N" is decoration; a failure here must not take the list down with it.
    countPendingCsamHolds(entityType).catch((err) => {
      console.error('CSAM hold total failed', err);
      return undefined;
    }),
  ]);
  return { limit, page, offset, entityType: entityType ?? null, total, ...queue, fullBleed: true };
};

const decideSchema = z.object({
  holdId: int4Id,
  decision: z.enum(CSAM_HOLD_DECISIONS),
  note: z
    .string()
    .trim()
    .max(NOTE_MAX_LENGTH, `The note is longer than ${NOTE_MAX_LENGTH} characters.`)
    .optional()
    .transform((v) => v || undefined),
});

export const actions: Actions = {
  decide: requiresGrant('csam.report.file', async ({ request, locals }) => {
    const input = parseForm(decideSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });

    const needed = CSAM_HOLD_DECISION_GRANTS[input.decision];
    if (needed && !locals.grants[needed])
      return fail(403, { scope: 'denied' as const, error: denied(needed), key: input.holdId });

    const result = await decideCsamHold(input);
    if (!result.ok) return fail(400, { error: result.error, key: input.holdId });
    return { success: true, key: input.holdId };
  }),
};
