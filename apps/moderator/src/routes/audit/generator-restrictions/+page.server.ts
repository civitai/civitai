import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseForm, parseQuery } from '$lib/server/query';
import { requiresGrant } from '$lib/server/access';
import { banFieldsSchema, banRemovalArgs, rejectUnexplainedOther } from '$lib/server/ban-input';
import { banConfirmed, resolveRestriction, setBanned } from '$lib/server/user-actions.service';
import {
  getGenerationRestrictions,
  saveSuspiciousMatches,
  RESTRICTION_TYPE,
  RESTRICTION_TYPES,
  unwiredRulingReason,
  type RestrictionRow,
} from '$lib/server/user-restriction.service';

const PAGE_SIZE = 20;

// Defaults to Pending, as the main app's page did. Without it the queue opens with already-ruled rows
// interleaved at the top, and `advance()` has nothing to advance past.
//
// `type` has no "any" member, unlike `status`. Mixing two kinds of review into one list would put a
// moderator one keystroke from ruling on a case with the wrong queue's assumptions in mind, and the
// ruling copy differs per type — so the queues stay disjoint and `.catch()` sends an unknown or absent
// value back to the type this page has always shown.
const querySchema = z.object({
  type: z.enum(RESTRICTION_TYPES).catch(RESTRICTION_TYPE),
  status: z.enum(['Pending', 'Upheld', 'Overturned', 'any']).catch('Pending'),
  q: z.string().trim().max(100).catch(''),
  page: z.coerce.number().int().min(1).max(500).catch(1),
  selected: z.coerce.number().int().positive().optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url }) => {
  const { type, status, q, page, selected } = parseQuery(url, querySchema);

  // A bare number is a user id, not a username: usernames are free text and an account named "12345"
  // would otherwise be the only way to reach user 12345.
  const asId = Number(q);
  const isUserId = q !== '' && Number.isInteger(asId) && asId > 0;

  const { items, totalCount } = await getGenerationRestrictions({
    page,
    limit: PAGE_SIZE,
    type,
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
    type,
    status,
    q,
    wide: true,
  };
};

// `type: 'any'` on purpose. A form posts to `?/resolve`, which REPLACES the query string — so an action
// never sees the `type` the moderator was looking at, and defaulting the lookup would 404 every row
// outside the default queue. The id is a primary key, so dropping the predicate cannot widen the
// result; what it changes is which types an action can be handed.
//
// Each action decides that for itself, and they do NOT all decide the same way — so this helper deliberately
// makes no such decision. `resolve` and `ban` call `unwiredRuling` because they hand the row to a verdict
// path that is still generation-shaped. `flagSuspicious` does not, and should not: it copies selected
// triggers into the shared suspicious-match list, writes nothing to the account, and tells the user
// nothing. A prompt worth flagging is worth flagging whatever queue it was raised in.
async function restrictionById(id: number): Promise<RestrictionRow | null> {
  const { items } = await getGenerationRestrictions({
    page: 1,
    limit: 1,
    type: 'any',
    restrictionId: id,
  });
  return items[0] ?? null;
}

/**
 * 🔴 Verdicts are still generation-shaped, so only generation rows may be ruled on.
 *
 * The main app's `resolveUserRestriction` — the single write path for a verdict — hardcodes the
 * `generation-restriction-upheld` / `-overturned` notification types, a `moderator:generationRestriction*`
 * update source, and a `restriction-upheld` / `-overturned` email, and on an overturn it resets the
 * *prompt* violation counter. Ruling on a non-generation row through it would tell the user their
 * generation access was restored over something unrelated to generation.
 *
 * This is a refusal rather than a hidden button because the check has to hold against a posted id, not
 * just against what the page chose to render. Lifting it means parameterising that verdict path first.
 * (The buttons are disabled as well now — see `RestrictionDetail.svelte`. That is an addition to this
 * check, never a substitute for it.)
 *
 * 🔴 KEPT even though the refusal is now enforced by `resolveUserRestriction` itself — which is what
 * closes the surfaces this check could never reach: the retool User Lookup panel, the tRPC router and
 * the REST endpoint were all unguarded while it lived only here. This is not defence in depth; it is
 * ORDERING. The `ban` action bans and THEN rules, so a refusal arriving inside the verdict call would
 * leave the account banned against a restriction nobody can close — the stranded Pending row that
 * handler exists to avoid. It also renders as an inline message rather than a failed API call.
 *
 * The predicate is IMPORTED, never re-spelled: `unwiredRulingReason` is one function in
 * `$lib/restriction-types`, pinned to the main app's `RULINGS_WIRED_FOR` by the seam test. A second
 * spelling here is exactly how the two would drift.
 */
function unwiredRuling(row: RestrictionRow): string | null {
  return unwiredRulingReason(row.type);
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
    const unwired = unwiredRuling(row);
    if (unwired) return fail(400, { error: unwired });

    const result = await resolveRestriction({
      userRestrictionId: input.userRestrictionId,
      status: input.status,
      userId: row.userId,
      moderatorId: locals.user.id,
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
    // Checked BEFORE the ban, not just before the resolve: this action bans and then rules, and a ban
    // that landed against a restriction that cannot be resolved leaves exactly the stranded Pending row
    // the `ban` handler exists to avoid.
    const unwired = unwiredRuling(row);
    if (unwired) return fail(400, { error: unwired });

    const banned = await setBanned({
      userId: row.userId,
      ban: true,
      reasonCode: input.reasonCode,
      detailsInternal: input.detailsInternal || undefined,
      detailsExternal: input.detailsExternal || undefined,
      ...banRemovalArgs(input, true),
      moderatorId: locals.user.id,
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
      moderatorId: locals.user.id,
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

    const saved = await saveSuspiciousMatches(matches, locals.user.id);
    return { success: true, savedCount: saved };
  },
};
