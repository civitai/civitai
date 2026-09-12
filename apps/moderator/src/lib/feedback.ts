// Pure decision functions behind `/feedback`. Everything here is reachable from the node test
// project, which is the reason it is not inlined into the page: a wrong answer in any of them is
// silent — a link to the wrong page, an area whose rows nobody can reach, a Grafana link that lands
// on an empty pane.

export const FEEDBACK_STATUSES = ['new', 'reviewed', 'actioned', 'dismissed'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const isFeedbackStatus = (value: string): value is FeedbackStatus =>
  (FEEDBACK_STATUSES as readonly string[]).includes(value);

export const DEFAULT_FEEDBACK_STATUSES: FeedbackStatus[] = ['new'];

const FEEDBACK_STATUS_BADGE: Record<FeedbackStatus, string> = {
  new: 'bg-blue-500/20 text-blue-300',
  reviewed: 'bg-amber-500/20 text-amber-300',
  actioned: 'bg-green-500/20 text-green-300',
  dismissed: 'bg-dark-4 text-dark-2',
};

/**
 * `Feedback.status` is a TEXT column behind a CHECK constraint, so what comes back is a `string`.
 * A row carrying a value this app does not know renders unstyled rather than crashing the queue.
 */
export const feedbackStatusBadgeClass = (status: string): string =>
  isFeedbackStatus(status) ? FEEDBACK_STATUS_BADGE[status] : '';

/**
 * The areas the PRODUCER knows about, mirrored from the main app's
 * `src/shared/constants/feedback.constants.ts`.
 *
 * 🔴 A MIRROR, not the source. `apps/moderator` is a separate SvelteKit app with no path to the
 * Next app's `src/`, and that constant is not exported from any workspace package, so there is no
 * import that would make these one value.
 *
 * The drift this can suffer is bounded and harmless in the direction that matters: the option list
 * is this list UNIONED with `SELECT DISTINCT area` (see `feedbackAreaOptions`), so an area added
 * upstream and missing here is still filterable the moment it has a row, and an area retired
 * upstream keeps its historical rows reachable. A stale entry here only ever adds an option that
 * matches nothing.
 */
export const FEEDBACK_KNOWN_AREAS = [
  'bitdex-image-feed',
  'apps-marketplace',
  'site-bug-report',
] as const;

/**
 * The area filter's options.
 *
 * 🔴 THE UNION IS THE WHOLE POINT. Reading the TS registry alone hides the rows of any area retired
 * from it, and reading the table alone hides an area that has no rows yet. Both failures are silent
 * — an empty list reads as "no such feedback", never as "that option is missing".
 */
export function feedbackAreaOptions(
  distinctAreas: readonly string[],
  knownAreas: readonly string[] = FEEDBACK_KNOWN_AREAS
): string[] {
  return [...new Set([...distinctAreas, ...knownAreas])].filter(Boolean).sort();
}

export type FeedbackFilters = Record<string, string | number | boolean>;

/**
 * Filter values that mean "not filtering" on the surfaces that emit them, keyed by param name.
 *
 * Mirrors `APPS_STORE_DEFAULTS` + `appsStoreFiltersToQuery` in the main app: `/apps` omits a
 * default from its own URL, so echoing one back builds a link the reporter never had.
 * `category: 'none'` is the marketplace context builder's sentinel for "no category selected" — an
 * explicit `undefined` fails the context schema's value union, so absence had to be spelled.
 */
const FILTER_DEFAULTS: Record<string, ReadonlyArray<string | number | boolean>> = {
  kind: ['all'],
  sort: ['top-rated'],
  category: ['none'],
};

/**
 * The URL the reporter was actually looking at.
 *
 * 🔴 `context.path` is `window.location.pathname` and carries NO query string, while on `/apps` the
 * query string IS the view — so `path` alone links to a different page than the one the report is
 * about. Rebuilding it is what makes a one-line complaint actionable.
 *
 * Returns `null` rather than a link when `path` is absent (it is `undefined` during SSR, by its own
 * type) — a link to `/` would be a confident answer to a question nobody can answer.
 *
 * Unknown filter keys are CARRIED, not dropped: `filters` is a free record written by whichever
 * surface produced the report, and silently discarding a key a future area puts there is the same
 * defect `splitContext`'s "other" bucket exists to prevent. A spurious param on the rebuilt link is
 * visible and inert (`/apps`' own schema is `.loose()`); a missing one is neither.
 */
export function reconstructFeedbackUrl(
  path: string | null | undefined,
  filters?: FeedbackFilters | null
): string | null {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (FILTER_DEFAULTS[key]?.includes(value)) continue;
    params.append(key, String(value));
  }

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export type FeedbackContext = {
  path: string | null;
  filters: FeedbackFilters | null;
  images: string[];
  screenshotId: string | null;
  sessionId: string | null;
  /** Everything the five named keys did not claim. `null` when there is nothing left over. */
  other: Record<string, unknown> | null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFilterValue = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/**
 * Split a stored `context` payload into the keys this panel renders and everything else.
 *
 * 🔴 THE "OTHER" BUCKET IS NOT A NICETY. `feedbackContextSchema` already accepts `reportedSource`,
 * `reportedPageSources` and `pagesLoaded`, which no current producer emits and a future area will.
 * A panel that renders only the five keys it knows about discards the payload of every area added
 * after it, and nothing says so.
 *
 * A known key holding an unexpected TYPE also lands in "other" rather than being dropped: `context`
 * is JSONB with no schema at rest, written by a zod schema in a different app, so the shape is a
 * claim. Showing the odd value beats pretending the key was absent.
 */
export function splitContext(context: unknown): FeedbackContext {
  const out: FeedbackContext = {
    path: null,
    filters: null,
    images: [],
    screenshotId: null,
    sessionId: null,
    other: null,
  };
  if (!isPlainObject(context)) return out;

  const other: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    if (key === 'path' && typeof value === 'string') {
      out.path = value;
    } else if (key === 'sessionId' && typeof value === 'string') {
      out.sessionId = value;
    } else if (key === 'screenshotId' && typeof value === 'string') {
      out.screenshotId = value;
    } else if (key === 'images' && Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      out.images = value as string[];
    } else if (key === 'filters' && isPlainObject(value) && Object.values(value).every(isFilterValue)) {
      out.filters = value as FeedbackFilters;
    } else {
      other[key] = value;
    }
  }

  if (Object.keys(other).length) out.other = other;
  return out;
}

/** Attachments on a row, for the list's 📎 column. Counts the opt-in page capture as one. */
export const feedbackAttachmentCount = (context: FeedbackContext): number =>
  context.images.length + (context.screenshotId ? 1 : 0);

/**
 * Loki's global `retention_period`, which `{source="faro-rum"}` sits on — it declares no
 * `retention_stream` override of its own.
 *
 * 🔴 A COPY OF A NUMBER OWNED BY ANOTHER REPO. Nothing makes the two agree. If Loki's retention is
 * ever shortened this page starts offering links that land on nothing, and the mismatch is
 * invisible from inside this codebase — so treat a LIVE link that returns no rows as evidence this
 * constant is stale, not as evidence Faro is broken.
 */
export const FARO_LOKI_RETENTION_HOURS = 72;

/** The window the Explore pane opens on, either side of the report. */
const FARO_WINDOW_MS = 60 * 60 * 1000;

/**
 * Loki's provisioned datasource uid — pinned in the GitOps values, not a generated hash, so it
 * survives a redeploy.
 */
const LOKI_DATASOURCE_UID = 'loki';

/**
 * The LogQL a moderator gets dropped into.
 *
 * 🔴 RAW SUBSTRING (`|= "<id>"`), NEVER `| logfmt | session_id="<id>"`. The id appears under TWO
 * keys in the same stream: `kind=event event_name=session_start` lines spell it `session_id=<id>`,
 * while `faro.tracing.fetch` lines spell it `event_data_session.id=<id>`. A logfmt filter on
 * `session_id` matches the first and silently drops the second — which are exactly the rows
 * carrying `traceID`/`spanID`. A filter returning SOME rows is the worst failure available here,
 * because it looks like it worked.
 *
 * The trade, stated rather than hidden: session ids are short opaque strings, so a substring match
 * is not provably collision-free. A stray extra line is visible to the reader; a dropped tracing
 * event is not.
 *
 * `JSON.stringify` builds the quoted literal so an id carrying a quote or a backslash cannot break
 * out of it — `sessionId` is client-supplied and bounded in length only.
 */
export const faroSessionExpr = (sessionId: string): string =>
  `{source="faro-rum"} |= ${JSON.stringify(sessionId)}`;

/**
 * A Grafana Explore link onto the reporter's own browser telemetry, or `null`.
 *
 * `now` is an ARGUMENT, never `Date.now()` inside: a function that reads the clock cannot be tested
 * at the boundary it exists to enforce.
 *
 * 🔴 Null on THREE different absences, and the caller must say which one it is rendering:
 *   - no `grafanaUrl` — the deployment has not been given `PUBLIC_GRAFANA_URL`. Emitting
 *     `undefined/explore` instead is a link that looks live and is not.
 *   - no `sessionId` — ordinary, not an error: Faro does not run in dev, test, preview, or an
 *     ad-blocked session.
 *   - the report is older than `FARO_LOKI_RETENTION_HOURS` — the rows are gone. "No logs found",
 *     "this session produced no telemetry" and "the link is broken" are three different facts with
 *     one observable, so the UI must name which one rather than showing an empty pane.
 *
 * THE BOUNDARY IS CLOSED ON THE EXPIRED SIDE: an age of exactly the retention window counts as
 * expired. At that instant the sample is at the edge of eviction, and the one outcome this whole
 * design exists to avoid is a link that resolves to nothing.
 */
export function faroSessionLink(input: {
  grafanaUrl: string | null | undefined;
  sessionId: string | null | undefined;
  createdAt: Date | string;
  now: number;
}): string | null {
  const base = input.grafanaUrl?.trim().replace(/\/+$/, '');
  if (!base) return null;
  const sessionId = input.sessionId?.trim();
  if (!sessionId) return null;

  const created = new Date(input.createdAt).getTime();
  if (Number.isNaN(created)) return null;
  if (input.now - created >= FARO_LOKI_RETENTION_HOURS * 60 * 60 * 1000) return null;

  const pane = {
    faro: {
      datasource: LOKI_DATASOURCE_UID,
      queries: [
        {
          refId: 'A',
          datasource: { type: 'loki', uid: LOKI_DATASOURCE_UID },
          editorMode: 'code',
          queryType: 'range',
          expr: faroSessionExpr(sessionId),
        },
      ],
      // Epoch-ms STRINGS, which is the shape Grafana's own Explore writes.
      range: {
        from: String(created - FARO_WINDOW_MS),
        to: String(created + FARO_WINDOW_MS),
      },
    },
  };

  const params = new URLSearchParams({
    schemaVersion: '1',
    orgId: '1',
    panes: JSON.stringify(pane),
  });
  return `${base}/explore?${params.toString()}`;
}
