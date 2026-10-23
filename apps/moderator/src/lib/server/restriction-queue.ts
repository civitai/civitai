import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions } from '@sveltejs/kit';
import { parseForm, parseQuery } from '$lib/server/query';
import { requiresGrant } from '$lib/server/access';
import type { RestrictionType } from '$lib/restriction-types';
import {
  DEFAULT_RESTRICTION_FILTERS,
  ORIGIN_FILTERS,
  RESTRICTION_STATUSES,
  resolveRestrictionFilters,
} from '$lib/restriction-filters';
import { banFieldsSchema, banRemovalArgs, rejectUnexplainedOther } from '$lib/server/ban-input';
import { banConfirmed, resolveRestriction, setBanned } from '$lib/server/user-actions.service';
import { checkedResolutionReason, resolutionReasonFields } from '$lib/server/resolution-reason';
import { planRemixSources } from '$lib/restrictions/origin';
import {
  getGenerationRestrictions,
  getRemixSources,
  SORT_ORDERS,
  getRestrictionFacets,
  saveSuspiciousMatches,
  type RemixSource,
  unwiredRulingReason,
  type RestrictionRow,
} from '$lib/server/user-restriction.service';

const TRIAGE_PAGE_SIZE = 50;

type QueueConfig = {
  types: readonly [RestrictionType, ...RestrictionType[]];
  fallback: RestrictionType;
};

/**
 * The query both queue reads share. `.catch()` on every field sends a stale or hostile URL back to the
 * default view instead of a 500.
 *
 * A bare number in `q` is a user id, not a username: usernames are free text and an account named
 * "12345" would otherwise be the only way to reach user 12345.
 */
function parseQueueQuery<S extends z.ZodRawShape>(url: URL, queue: QueueConfig, extra: S) {
  const base = z.object({
    type: z.enum(queue.types).catch(queue.fallback),
    status: z.enum(RESTRICTION_STATUSES).catch(DEFAULT_RESTRICTION_FILTERS.status),
    q: z.string().trim().max(100).catch(''),
    page: z.coerce.number().int().min(1).max(500).catch(1),
  });
  const parsed = parseQuery(url, base.extend(extra)) as z.output<typeof base> &
    z.output<z.ZodObject<S>>;
  const asId = Number(parsed.q);
  const isUserId = parsed.q !== '' && Number.isInteger(asId) && asId > 0;
  return {
    ...parsed,
    username: !isUserId && parsed.q ? parsed.q : undefined,
    userId: isUserId ? asId : undefined,
  };
}

const selectedSchema = z.coerce.number().int().positive().optional().catch(undefined);

/**
 * The restriction queues' read: status (Pending by default), origin, sort, search and paging. The whole
 * page ships at once: selection is client state, so the remix sources for every row have to be on it.
 */
export async function restrictionTriageLoad(url: URL, queue: QueueConfig) {
  const { type, status, origin, sort, q, page, selected, username, userId } = parseQueueQuery(
    url,
    queue,
    {
      origin: z.enum(ORIGIN_FILTERS).optional().catch(undefined),
      sort: z.enum(SORT_ORDERS).optional().catch(undefined),
      selected: selectedSchema,
    }
  );
  const query = {
    type,
    status: status === 'any' ? undefined : status,
    origin,
    username,
    userId,
  };

  const [{ items, totalCount }, facets] = await Promise.all([
    getGenerationRestrictions({ page, limit: TRIAGE_PAGE_SIZE, ...query, sort }),
    // Counts are decoration: a failed count must not take the list down with it.
    getRestrictionFacets(query).catch((err) => {
      console.error('Restriction facet counts failed', err);
      return undefined;
    }),
  ]);

  // A deep link may name a restriction the filters or paging leave off this page; it opens regardless
  // rather than the pane silently showing another row. Held to this page's own types, and to the type
  // it is filtered to: a row of the other type would contradict the filter the moderator chose.
  let pinned: RestrictionRow | null = null;
  let selectedMissing: number | null = null;
  if (selected && !items.some((i) => i.id === selected)) {
    pinned = await restrictionById(selected, queue.types);
    if (pinned && pinned.type !== type) pinned = null;
    if (!pinned) selectedMissing = selected;
  }

  // A failed source lookup must not take the queue down, but it must not read as "no source" either.
  const plan = planRemixSources(pinned ? [...items, pinned] : items);
  let sources: Record<number, RemixSource> = {};
  let sourcesFailed = false;
  try {
    sources = Object.fromEntries((await getRemixSources(plan.lookup)).map((s) => [s.id, s]));
  } catch {
    sourcesFailed = true;
  }

  return {
    items,
    pinned,
    selectedMissing,
    sources,
    sourcesFailed,
    sourcesNotLoaded: plan.notLoaded,
    facets,
    totalCount,
    page,
    hasMore: page * TRIAGE_PAGE_SIZE < totalCount,
    offset: (page - 1) * TRIAGE_PAGE_SIZE,
    type,
    filters: resolveRestrictionFilters({ status, origin, sort }),
    q,
    fullBleed: true,
    headerInline: true,
  };
}

// `type: 'any'` on purpose. A form posts to `?/resolve`, which REPLACES the query string — so an action
// never sees the `type` the moderator was looking at, and defaulting the lookup would 404 every row
// outside the default queue. The id is a primary key, so dropping the predicate cannot widen the
// result; what it changes is which types an action can be handed.
//
// Each action decides that for itself, and they do NOT all decide the same way — so this helper deliberately
// makes no such decision. `resolve` and `ban` call `unwiredRuling` because they hand the row to a verdict
// path that only some types have. `flagSuspicious` does not, and should not: it copies selected
// triggers into the shared suspicious-match list, writes nothing to the account, and tells the user
// nothing. Scam triggers are excluded because they are not prompts.
//
// 🔴 The page's own `types` are enforced on the row afterwards: pages are granted separately, so a role
// holding one queue must not rule on, ban from or flag from the other's rows by posting an id.
async function restrictionById(
  id: number,
  types: readonly RestrictionType[]
): Promise<RestrictionRow | null> {
  const { items } = await getGenerationRestrictions({
    page: 1,
    limit: 1,
    type: 'any',
    restrictionId: id,
  });
  const row = items[0];
  return row && (types as readonly string[]).includes(row.type) ? row : null;
}

/**
 * 🔴 Only types with verdict effects may be ruled on.
 *
 * The main app's `resolveUserRestriction` — the single write path for a verdict — takes its notices,
 * update sources and overturn effect from a per-type table, and refuses a type without an entry.
 *
 * This is a refusal rather than a hidden button because the check has to hold against a posted id, not
 * just against what the page chose to render. (The buttons are disabled as well — see
 * `RestrictionDecisionForm.svelte`. That is an addition to this check, never a substitute for it.)
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

export const restrictionActions = (types: readonly RestrictionType[]): Actions => ({
  resolve: async ({ request, locals }) => {
    const input = parseForm(
      z.object({
        userRestrictionId: z.coerce.number().int().positive(),
        status: z.enum(['Upheld', 'Overturned']),
        ...resolutionReasonFields,
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });

    // Owner read from the restriction, never the form: this id is what the ModActivity row names, so a
    // posted one lets the audit trail record an account that was never acted on.
    const row = await restrictionById(input.userRestrictionId, types);
    if (!row) return fail(404, { error: 'Restriction not found.' });
    const unwired = unwiredRuling(row);
    if (unwired) return fail(400, { error: unwired });
    const reason = checkedResolutionReason('restriction', input.status, input);
    if (typeof reason === 'string') return fail(400, { error: reason });

    const result = await resolveRestriction({
      userRestrictionId: input.userRestrictionId,
      status: input.status,
      ...reason,
      userId: row.userId,
      moderatorId: locals.user.id,
    });
    return result.ok ? { success: true } : fail(400, { error: result.error });
  },

  // Banning also rules on the restriction, matching the main app: a banned account left with a Pending
  // row keeps its cancelled subscription and is never told the outcome.
  ban: requiresGrant('audit.ban.execute', async ({ request, locals }) => {
    const input = parseForm(
      banFieldsSchema.extend({
        userRestrictionId: z.coerce.number().int().positive(),
        ...resolutionReasonFields,
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    const unexplained = rejectUnexplainedOther(input);
    if (unexplained) return fail(400, { error: unexplained });

    // The account banned is the restriction's owner, not whoever the form named.
    const row = await restrictionById(input.userRestrictionId, types);
    if (!row) return fail(404, { error: 'Restriction not found.' });
    // Checked BEFORE the ban, not just before the resolve: this action bans and then rules, and a ban
    // that landed against a restriction that cannot be resolved leaves exactly the stranded Pending row
    // the `ban` handler exists to avoid.
    const unwired = unwiredRuling(row);
    if (unwired) return fail(400, { error: unwired });
    // Before the ban for the same reason: a ban that lands and then fails the reason check strands
    // the Pending row. The ban form has one internal-note box, and it is the ruling's note as well.
    const reason = checkedResolutionReason('restriction', 'Upheld', {
      resolvedReason: input.resolvedReason,
      internalNotes: input.detailsInternal,
    });
    if (typeof reason === 'string') return fail(400, { error: reason });

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
      ...reason,
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

    const row = await restrictionById(id.data, types);
    if (!row) return fail(404, { error: 'Restriction not found.' });

    const matches = row.triggers
      .filter((t) => keys.has(t.key) && t.category !== 'scam')
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
});
