import { LIVE_STATUSES } from './statuses';
import { TICKET_ROUTING } from './routing';

/** Freshdesk rejects a search expression longer than this. */
export const SEARCH_QUERY_MAX_CHARS = 512;

const anyOf = (terms: readonly string[]) => `(${terms.join(' OR ')})`;
const LIVE = anyOf(LIVE_STATUSES.map((s) => `status:${s}`));

/** Live tickets with a moderation feature or status, needing no router. A superset: `routeTicket` still drops the sent-to-support ones. */
export const moderationQuery = (): string =>
  `${anyOf([
    ...TICKET_ROUTING.moderationFeatures.map((f) => `cf_feature:'${f}'`),
    ...TICKET_ROUTING.moderationStatuses.map((s) => `status:${s}`),
  ])} AND ${LIVE}`;

/** Live tickets with no `cf_feature`: the ones the router's topic may move into moderation. */
export const unclassifiedQuery = (): string => `cf_feature:null AND ${LIVE}`;

/** The support view has no narrower filter, so it reads one status at a time. */
export const statusQuery = (status: number): string => `status:${status}`;

/** An inclusive run of calendar days, `YYYY-MM-DD`. */
export type DayRange = { from: string; to: string };

const DAY_MS = 86_400_000;
const toMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => toDay(toMs(day) + n * DAY_MS);

/**
 * `expression` restricted to creation days within `range`. Parenthesised so an `OR` in it cannot absorb
 * the window. Freshdesk compares `created_at` by day, so the bounds sit one day outside; if the
 * comparison is inclusive the windows overlap by a day, which `readAll`'s dedupe by ticket id absorbs.
 */
export const createdWithin = (expression: string, { from, to }: DayRange): string =>
  `(${expression}) AND created_at:>'${addDays(from, -1)}' AND created_at:<'${addDays(to, 1)}'`;

/** The two halves of a range, adjacent and non-overlapping, or null for a single day. */
export function bisectDays({ from, to }: DayRange): [DayRange, DayRange] | null {
  const days = Math.round((toMs(to) - toMs(from)) / DAY_MS) + 1;
  if (days < 2) return null;
  const mid = addDays(from, Math.ceil(days / 2) - 1);
  return [
    { from, to: mid },
    { from: addDays(mid, 1), to },
  ];
}
