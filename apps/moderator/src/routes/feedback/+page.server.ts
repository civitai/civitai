import { redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/public';
import type { Actions, PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { MAX_INT4 } from '$lib/server/users.service';
import { DEFAULT_FEEDBACK_STATUSES, feedbackAreaOptions, isFeedbackStatus } from '$lib/feedback';
import { FEEDBACK_CURSOR_VALUE_PARAM, parseFeedbackSort } from '$lib/feedback-sort';
import { FEEDBACK_OPEN_PARAM } from '$lib/feedback-open';
import { bulkTriageAction, promoteAction, triageAction } from '$lib/server/feedback-actions';
import {
  FEEDBACK_PAGE_SIZE,
  feedbackPanelExtras,
  getFeedbackAreas,
  getFeedbackList,
  isMissingTriageColumns,
} from '$lib/server/feedback.service';

// Give every field a `.catch()`: query params are user-controllable, so a bad value degrades to the
// default rather than 500ing a queue nobody can then open. The int4 bound matters — a larger value
// ERRORS the comparison in Postgres rather than missing.
const querySchema = z.object({
  status: z.array(z.string()).catch([]),
  area: z.string().trim().catch(''),
  cursor: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
  // The CONSTANT as the key, like `cursorValue` below: renaming the param breaks the destructure
  // at compile time instead of silently reading a field nothing writes.
  [FEEDBACK_OPEN_PARAM]: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
  /**
   * The compound keyset's value half. Bounded in LENGTH only and never coerced here: which type it
   * has to be depends on which column `?sort=` names, and that mapping is the service's — see
   * `FEEDBACK_SORT_KEYS`. The bound exists because this reaches Postgres as a parameter and an
   * unbounded one is free work for whoever hand-edits the URL.
   */
  [FEEDBACK_CURSOR_VALUE_PARAM]: z.string().max(300).optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url, request, locals }) => {
  // `cursorValue` is destructured by its literal name on purpose: the schema key above is the
  // CONSTANT, so renaming the param breaks this line at compile time rather than silently reading a
  // field nothing writes.
  const { status, area, cursor, open, cursorValue } = parseQuery(url, querySchema, ['status']);
  // Both params are typed by whoever is holding the keyboard. `parseFeedbackSort` is an allowlist
  // membership test, so an unknown column degrades to the default ordering rather than reaching the
  // query builder.
  //
  // 🔴 THE SERVICE REFUSES A SECOND TIME AND THROWS RATHER THAN DEGRADING, so this line is also the
  // thing that keeps a hand-typed `?sort=` off the error boundary: everything the parser emits is a
  // state `getFeedbackList` accepts. Do not "simplify" this to reading the params directly.
  const sort = parseFeedbackSort(url.searchParams);
  /**
   * 🔴 PRESENT-BUT-REJECTED IS NOT ABSENT, AND THE TWO ARE OPPOSITE INSTRUCTIONS. `.catch(undefined)`
   * collapses a param the schema refused into the same value as one that was never sent — and the
   * service reads an absent value half as "the boundary row's value IS null", a real position in the
   * ordering. So an over-long `?cursorValue=` would not degrade, it would silently relocate the
   * operator into the trailing null block. Nothing else on this page has this problem: every other
   * param's rejected value and its absent value mean the same thing.
   *
   * The whole cursor goes, not just the half — the service's own contract, for the same reason.
   */
  const cursorValueRejected =
    url.searchParams.has(FEEDBACK_CURSOR_VALUE_PARAM) && cursorValue === undefined;
  // A present-but-empty `?status=` is a deliberate "all"; an ABSENT one is the default view.
  const statuses = url.searchParams.has('status')
    ? status.filter(isFeedbackStatus)
    : DEFAULT_FEEDBACK_STATUSES;

  // Canonicalise a bare landing so the active default is explicit and shareable.
  //
  // 🔴 GET only. A form action posts to `?/triage`, which replaces the whole query string, so on a
  // POST this condition is true — and a 307 PRESERVES THE METHOD, so a no-JS client would re-POST
  // and run the action a second time, tripping its own concurrency guard and reporting a spurious
  // conflict over a save that worked. Enhanced submits never reach `load`, so the JS path never saw
  // it. The defaults above apply either way, so skipping the redirect changes nothing on screen.
  if (request.method === 'GET' && !url.searchParams.has('status')) {
    const canonical = new URL(url);
    DEFAULT_FEEDBACK_STATUSES.forEach((s) => canonical.searchParams.append('status', s));
    redirect(307, canonical.pathname + canonical.search);
  }

  /**
   * 🔴 The migration is applied BY HAND, per environment, and this page reaches production before
   * anyone runs it. `moderator:admin` short-circuits every page grant, so the sidebar entry and its
   * badge are live on the day this deploys — and the badge counts on `status` alone, so it renders
   * a real number against an unmigrated database. The click is what breaks: the list selects four
   * columns that do not exist yet.
   *
   * Degraded rather than thrown. An uncaught 42703 out of `load` is the error boundary plus an
   * Axiom entry per click, and it tells the operator nothing about what to do.
   */
  let list: Awaited<ReturnType<typeof getFeedbackList>>;
  let areas: string[];
  try {
    [list, areas] = await Promise.all([
      getFeedbackList({
        statuses,
        area: area || null,
        cursor: cursorValueRejected ? null : cursor ?? null,
        cursorValue: cursorValue ?? null,
        sort,
        limit: FEEDBACK_PAGE_SIZE,
      }),
      getFeedbackAreas(),
    ]);
  } catch (e) {
    if (!isMissingTriageColumns(e)) throw e;
    return {
      items: [],
      nextCursor: null,
      nextCursorValue: null,
      sort,
      statuses,
      area,
      open: null,
      openVisible: false,
      siblings: [],
      knownIssues: [],
      areaOptions: [],
      grafanaUrl: null,
      migrationPending: true as const,
    };
  }

  /**
   * Only for the row that is actually open — the one read on this page that is not needed to render
   * the list. The conditions inside `feedbackPanelExtras` are shared with `/feedback/<id>`, which
   * renders the same panel; only "is a row open at all" is the queue's own question.
   */
  const openRow = open ? list.items.find((r) => r.id === open) : undefined;
  const { siblings, knownIssues } = openRow
    ? await feedbackPanelExtras(openRow, locals.grants)
    : { siblings: [], knownIssues: [] };

  return {
    migrationPending: false as const,
    items: list.items,
    nextCursor: list.nextCursor,
    nextCursorValue: list.nextCursorValue,
    sort,
    statuses,
    area,
    open: open ?? null,
    // A shared `?open=` can name a row the current filters exclude. Said out loud rather than
    // rendering nothing, which is indistinguishable from no row being open at all.
    openVisible: !!openRow,
    siblings,
    knownIssues,
    areaOptions: feedbackAreaOptions(areas),
    /**
     * 🔴 NULL when unset, and the panel renders no link at all in that case. A missing base would
     * otherwise build `undefined/explore`, which looks live and is not. The origin is deliberately
     * absent from this repo — see `.env.example`.
     */
    grafanaUrl: env.PUBLIC_GRAFANA_URL?.trim() || null,
  };
};

/**
 * The queue's three writes, all of which live in `$lib/server/feedback-actions.ts` — `/feedback/<id>`
 * registers two of the same handlers, and a form action is resolved against the route its FORM is
 * on, so the definitions cannot live beside either page.
 *
 * `bulkTriage` is the queue's alone: there is no selection on a single-report page.
 */
export const actions: Actions = {
  triage: triageAction,
  bulkTriage: bulkTriageAction,
  promote: promoteAction,
};
