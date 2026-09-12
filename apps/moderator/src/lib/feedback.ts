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
 * 🔴 A MIRROR of `FEEDBACK_AREAS` in the main app's `src/shared/constants/feedback.constants.ts`,
 * which is not exported from any workspace package — so nothing keeps the two in step. The union in
 * `feedbackAreaOptions` is what bounds the damage. To make them ONE value, move the constant into
 * `@civitai/shared` and leave a re-export shim, as `basemodel.constants.ts` already does.
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
 * 🔴 `context.path` is `window.location.pathname` and carries NO query string, while on `/apps` the
 * query string IS the view — so `path` alone links to a DIFFERENT page than the one the report is
 * about.
 *
 * `null` rather than a link when `path` is absent (it is `undefined` during SSR by its own type) or
 * is not a plain path — it is client-supplied. Rejecting `//host` is defence in depth rather than a
 * live fix: today's only caller concatenates onto a full ORIGIN, where `//host` stays a path. A
 * caller that ever concatenates onto a bare scheme would be handed a host swap.
 *
 * Unknown filter keys are CARRIED, for the reason `splitContext`'s "other" bucket exists: a
 * spurious param on the rebuilt link is visible and inert, a missing one is neither.
 *
 * The empty-string-means-absent rule here is the same one `$lib/url.ts` applies to live filters.
 */
export function reconstructFeedbackUrl(
  path: string | null | undefined,
  filters?: FeedbackFilters | null
): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;

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
 * A Cloudflare-images key, as the delivery URL builder requires one.
 *
 * 🔴 THIS IS A SECURITY GUARD, NOT A TIDINESS ONE. `getEdgeUrl` returns its argument VERBATIM when
 * it starts with `http` or `blob` (`$lib/media/edge-url.ts`), and the producer bounds these values
 * by LENGTH ONLY — `z.string().trim().min(1).max(100)`, no format at all. So an unfiltered id
 * renders `<img src="https://attacker.example/x.png">` in a moderator's browser: an arbitrary
 * outbound request, giving the reporter a read receipt naming which moderator opened their report
 * and when. That is wider than the accepted risk, which was about objects in our OWN account.
 *
 * What actually closes it is that `:` and `/` are excluded, so no absolute, protocol-relative or
 * `data:` URL can match and no path can be traversed. The leading negative lookahead is separate
 * and smaller: without it an id spelled `httpsomething` still takes `getEdgeUrl`'s verbatim branch
 * and renders as a broken SAME-ORIGIN relative src instead of a CDN one.
 *
 * A rejected value is not dropped — it goes to "other" and is shown as text — so nothing is hidden
 * from triage, it just stops being a URL the browser fetches.
 */
const IMAGE_KEY = /^(?!https?|blob)[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/;

/**
 * 🔴 THE "OTHER" BUCKET IS NOT A NICETY. `feedbackContextSchema` already accepts keys no current
 * producer emits, so a panel rendering only the five it knows about discards the payload of every
 * area added after it, silently. A known key holding an unexpected TYPE or an unusable VALUE lands
 * there too — `context` is JSONB with no schema at rest, so its shape is a claim.
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
    } else if (key === 'screenshotId' && typeof value === 'string' && IMAGE_KEY.test(value)) {
      out.screenshotId = value;
    } else if (
      key === 'images' &&
      Array.isArray(value) &&
      value.every((v) => typeof v === 'string')
    ) {
      // Deduplicated as well as filtered: `{#each … (id)}` THROWS on a duplicate key in production
      // as well as in dev, and the array is client-supplied with no uniqueness constraint anywhere
      // — so one repeated id makes the report permanently unopenable.
      out.images = [...new Set((value as string[]).filter((v) => IMAGE_KEY.test(v)))];
      // Anything dropped is still shown, as text, under "Other context".
      if (out.images.length !== value.length) other[key] = value;
    } else if (
      key === 'filters' &&
      isPlainObject(value) &&
      Object.values(value).every(isFilterValue)
    ) {
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
