import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { parseForm } from '$lib/server/query';
import { parseTypedCount } from '$lib/count-input';
import { enqueueUnpublishedVersionPosts, planEnqueue } from '$lib/server/unpublished-version-posts';

// Under /admin, so the hook already limits it to the super role; each action checks again so a
// moved route cannot quietly widen who files thousands of reports.
const PAGE = '/admin/unpublished-version-posts';

/** One reason code per line or comma-separated, as pasted. */
const reasonsField = z
  .string()
  .transform((raw) => [
    ...new Set(
      raw
        .split(/[\n,]/)
        .map((r) => r.trim())
        .filter(Boolean)
    ),
  ])
  .pipe(
    z
      .array(z.string().max(100, 'A reason code is at most 100 characters.'))
      .min(1, 'Enter at least one unpublish reason code.')
      .max(20, 'At most 20 reason codes.')
  );

export const load: PageServerLoad = async ({ locals }) => {
  requireAccess(locals.user, PAGE);
  return {};
};

export const actions: Actions = {
  dryRun: async ({ request, locals }) => {
    requireAccess(locals.user, PAGE);
    const form = await request.formData();
    const input = parseForm(z.object({ reasons: reasonsField }), form);
    // The text as typed, so a refused list stays in the box to be corrected.
    if (typeof input === 'string')
      return fail(400, {
        error: input,
        typedReasons: String(form.get('reasons') ?? '').slice(0, 4000),
      });

    return {
      kind: 'plan' as const,
      reasons: input.reasons,
      plan: await planEnqueue(input.reasons),
    };
  },

  run: async ({ request, locals }) => {
    requireAccess(locals.user, PAGE);
    const form = await request.formData();
    const input = parseForm(z.object({ reasons: reasonsField, expectedCount: z.string() }), form);
    if (typeof input === 'string') return fail(400, { error: input });
    const expectedCount = parseTypedCount(input.expectedCount);
    if (expectedCount === null)
      return fail(400, {
        error: 'Type the eligible count from the dry run as digits, e.g. 1,234.',
        reasons: input.reasons,
      });

    const result = await enqueueUnpublishedVersionPosts({
      reasons: input.reasons,
      expectedCount,
      moderatorId: locals.user.id,
    });
    if (!result.ok && result.reason === 'failed')
      return fail(500, {
        error: `A page failed after ${result.reported} posts were reported. Those stay filed and a rerun skips them. Dry-run again.`,
        reasons: input.reasons,
      });
    if (!result.ok)
      return fail(409, {
        error: `You typed ${expectedCount} but ${result.plan.eligible} are eligible now. Nothing was filed.`,
        reasons: input.reasons,
        plan: result.plan,
      });
    return { kind: 'filed' as const, reasons: input.reasons, reported: result.reported };
  },
};
