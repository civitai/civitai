import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseForm, parseQuery } from '$lib/server/query';
import { dbWrite } from '$lib/server/db';
import { requiresGrant } from '$lib/server/access';
import { banFieldsSchema, rejectUnexplainedOther } from '$lib/server/ban-input';
import { resolveRestriction, setBanned } from '$lib/server/user-actions.service';
import {
  getGenerationRestrictions,
  saveSuspiciousMatches,
  type RestrictionRow,
} from '$lib/server/user-restriction.service';

const PAGE_SIZE = 20;

// Defaults to Pending, as the main app's page did. Without it the queue opens with already-ruled rows
// interleaved at the top, and `advance()` has nothing to advance past.
const querySchema = z.object({
  status: z.enum(['Pending', 'Upheld', 'Overturned', 'any']).catch('Pending'),
  q: z.string().trim().max(100).catch(''),
  page: z.coerce.number().int().min(1).max(500).catch(1),
  selected: z.coerce.number().int().positive().optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url }) => {
  const { status, q, page, selected } = parseQuery(url, querySchema);

  // A bare number is a user id, not a username: usernames are free text and an account named "12345"
  // would otherwise be the only way to reach user 12345.
  const asId = Number(q);
  const isUserId = q !== '' && Number.isInteger(asId) && asId > 0;

  const { items, totalCount } = await getGenerationRestrictions({
    page,
    limit: PAGE_SIZE,
    status: status === 'any' ? undefined : status,
    username: !isUserId && q ? q : undefined,
    userId: isUserId ? asId : undefined,
  });

  const current: RestrictionRow | null = items.find((i) => i.id === selected) ?? null;

  return {
    items,
    current,
    totalCount,
    page,
    pageCount: Math.max(1, Math.ceil(totalCount / PAGE_SIZE)),
    status,
    q,
    wide: true,
  };
};

/** The endpoint is fire-and-forget, so this polls rather than reads once. Short, because a moderator is
 *  waiting on it, and a false negative only withholds the automatic ruling — it never bans twice. */
async function banConfirmed(userId: number): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const row = await dbWrite
      .selectFrom('User')
      .select('bannedAt')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (row?.bannedAt) return true;
  }
  return false;
}

async function restrictionById(id: number): Promise<RestrictionRow | null> {
  const { items } = await getGenerationRestrictions({ page: 1, limit: 1, restrictionId: id });
  return items[0] ?? null;
}

export const actions: Actions = {
  resolve: async ({ request, locals }) => {
    const input = parseForm(
      z.object({
        userRestrictionId: z.coerce.number().int().positive(),
        status: z.enum(['Upheld', 'Overturned']),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });

    // Owner read from the restriction, never the form: this id is what the ModActivity row names, so a
    // posted one lets the audit trail record an account that was never acted on.
    const row = await restrictionById(input.userRestrictionId);
    if (!row) return fail(404, { error: 'Restriction not found.' });

    const result = await resolveRestriction({
      userRestrictionId: input.userRestrictionId,
      status: input.status,
      userId: row.userId,
      moderatorId: locals.user!.id,
    });
    return result.ok ? { success: true } : fail(400, { error: result.error });
  },

  // Banning also rules on the restriction, matching the main app: a banned account left with a Pending
  // row keeps its cancelled subscription and is never told the outcome.
  ban: requiresGrant('audit.ban.execute', async ({ request, locals }) => {
    const input = parseForm(
      banFieldsSchema.extend({ userRestrictionId: z.coerce.number().int().positive() }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    const unexplained = rejectUnexplainedOther(input);
    if (unexplained) return fail(400, { error: unexplained });

    // The account banned is the restriction's owner, not whoever the form named.
    const row = await restrictionById(input.userRestrictionId);
    if (!row) return fail(404, { error: 'Restriction not found.' });

    const banned = await setBanned({
      userId: row.userId,
      ban: true,
      reasonCode: input.reasonCode,
      detailsInternal: input.detailsInternal || undefined,
      detailsExternal: input.detailsExternal || undefined,
      removeMedia: input.removeMedia,
      removeModels: input.removeModels,
      moderatorId: locals.user!.id,
    });
    if (!banned.ok) return fail(400, { error: banned.error });

    // `/api/mod/ban-user` answers 200 BEFORE it does the work and logs its failures rather than
    // returning them, so a 200 means "accepted", not "banned". Upholding on the strength of that closes
    // the queue row for a ban that may never have landed — re-read until it shows, and say so if not.
    if (!(await banConfirmed(row.userId)))
      return fail(502, {
        error:
          'The ban was accepted but has not taken effect yet. The restriction was NOT resolved — reload and check the account before ruling.',
      });

    const resolved = await resolveRestriction({
      userRestrictionId: input.userRestrictionId,
      status: 'Upheld',
      userId: row.userId,
      moderatorId: locals.user!.id,
    });
    return resolved.ok
      ? { success: true }
      : fail(400, { error: `Banned, but the restriction was not resolved: ${resolved.error}` });
  }),

  // Triggers are re-read here rather than taken from the form: the browser only sends which cards were
  // ticked, and trusting it for the prompt text would let a stale page write a record of a prompt the
  // restriction never held.
  flagSuspicious: async ({ request, locals }) => {
    const form = await request.formData();
    const id = z.coerce.number().int().positive().safeParse(form.get('userRestrictionId'));
    if (!id.success) return fail(400, { error: 'Missing restriction id.' });

    const keys = new Set(form.getAll('key').map(String));
    if (!keys.size) return fail(400, { error: 'Nothing selected.' });

    const row = await restrictionById(id.data);
    if (!row) return fail(404, { error: 'Restriction not found.' });

    const matches = row.triggers
      .filter((t) => keys.has(t.key))
      .map((t) => ({
        odometer: row.id,
        userId: row.userId,
        prompt: t.prompt ?? '',
        negativePrompt: t.negativePrompt,
        check: t.category ?? 'unknown',
        matchedText: t.matchedWord ?? '',
        regex: t.matchedRegex,
      }));
    if (!matches.length) return fail(400, { error: 'None of the selected triggers still exist.' });

    const saved = await saveSuspiciousMatches(matches, locals.user!.id);
    return { success: true, savedCount: saved };
  },
};
