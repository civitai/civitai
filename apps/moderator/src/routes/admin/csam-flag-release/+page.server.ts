import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { isSuper } from '$lib/server/access';
import { int4Id, parseForm } from '$lib/server/query';
import {
  APPROVAL_REF_PATTERN,
  RELEASABLE_LEGS,
  releaseHeldUserCsamFlags,
  type ReleaseHeldFlagsResult,
} from '$lib/server/csam-flag-clear';

// The `/admin` gate already admits only the admin role. Each action checks again, so moving or
// regranting the page cannot widen who may override a hold.
const isAdmin = (locals: App.Locals) => isSuper(locals.user);

export const load: PageServerLoad = async ({ locals }) => {
  if (!isAdmin(locals)) error(403, 'Admins only.');
  return { releasableLegs: [...RELEASABLE_LEGS] };
};

const countSchema = z.object({
  userId: int4Id,
  approvalRef: z
    .string()
    .trim()
    .regex(
      APPROVAL_REF_PATTERN,
      'The approval reference must look like 2026-01-31-120000-0123abcd.'
    ),
  reason: z
    .string()
    .trim()
    .min(1, 'Give a reason.')
    .max(1000, 'Keep the reason under 1000 characters.'),
});
// Typed in by hand from the count step, never carried over from it: a number nobody read is no check.
const releaseSchema = countSchema.extend({ expectedCount: z.coerce.number().int().positive() });

function refusal(userId: number, result: Extract<ReleaseHeldFlagsResult, { ok: false }>) {
  switch (result.reason) {
    case 'not-held':
      return `User #${userId} is not held. Clear their flags from the CSAM queue instead.`;
    case 'held':
      return `User #${userId} is held by: ${result.legs.join(', ')}. Only ${RELEASABLE_LEGS.join(
        ', '
      )} can be overridden here. Nothing was released.`;
    case 'changed':
      return `User #${userId}'s count is not the number you entered. Nothing was released. Count again.`;
    case 'unavailable':
      return 'This database has no release table yet. Nothing was released.';
  }
}

export const actions: Actions = {
  count: async ({ request, locals }) => {
    if (!isAdmin(locals)) return fail(403, { error: 'Admins only.' });
    const input = parseForm(countSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const result = await releaseHeldUserCsamFlags({
      ...input,
      moderatorId: locals.user.id,
      dryRun: true,
    });
    if (!result.ok) return fail(409, { error: refusal(input.userId, result) });
    return { counted: { ...input, count: result.count, legs: result.legs } };
  },

  release: async ({ request, locals }) => {
    if (!isAdmin(locals)) return fail(403, { error: 'Admins only.' });
    const input = parseForm(releaseSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const result = await releaseHeldUserCsamFlags({ ...input, moderatorId: locals.user.id });
    if (!result.ok) return fail(409, { error: refusal(input.userId, result) });
    return {
      released: `Released ${result.count} flag${result.count === 1 ? '' : 's'} for user #${
        input.userId
      }.${result.remaining ? ` ${result.remaining} still need a verdict.` : ''}`,
    };
  },
};
