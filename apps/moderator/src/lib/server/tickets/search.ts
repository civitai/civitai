import {
  SEARCH_MAX_PAGES,
  SEARCH_PAGE_SIZE,
  type TicketSearchPage,
  type TicketSummary,
} from '../freshdesk.service';
import { bisectDays, createdWithin, addDays, type DayRange } from '$lib/tickets/queries';

const PAGE_SIZE = SEARCH_PAGE_SIZE;
const MAX_PAGES = SEARCH_MAX_PAGES;
/** One expression yields at most this many tickets. */
const MAX_RESULTS = PAGE_SIZE * MAX_PAGES;

/** No Freshdesk account here predates this. */
const EARLIEST_DAY = '2015-01-01';

export type FetchPage = (expression: string, page: number) => Promise<TicketSearchPage>;

/** Freshdesk calls one list load may still make. The account's rate limit is shared by everyone. */
export type Budget = { left: number };

export type Searched =
  | {
      status: 'ok';
      tickets: TicketSummary[];
      /** What Freshdesk reported for the whole expression; null when it was never asked. */
      total: number | null;
      /** Whether every ticket the expression matches was read. */
      complete: boolean;
      /** Requests that failed after the first one. */
      failedRequests: number;
    }
  | { status: 'unavailable'; reason: string };

/**
 * Every ticket one expression matches. A search that matches more than the ceiling is split into
 * windows of creation days, halving any window that is still over it, so nothing is silently dropped.
 * Whatever cannot be read (budget spent, a failed request, one day over the ceiling) is reported
 * through `complete` and `failedRequests` with the tickets that were read.
 *
 * Only the first request failing fails the read: without it the total is unknown.
 */
export async function readAll(
  expression: string,
  fetchPage: FetchPage,
  budget: Budget,
  today: string
): Promise<Searched> {
  if (budget.left < 1)
    return { status: 'ok', tickets: [], total: null, complete: false, failedRequests: 0 };
  budget.left -= 1;
  const first = await fetchPage(expression, 1);
  if (first.status !== 'ok') return first;

  const found = new Map<string, TicketSummary>();
  let complete = true;
  let failedRequests = 0;
  const add = (tickets: TicketSummary[]) => tickets.forEach((t) => found.set(t.id, t));

  /** Pages 2.. of an expression whose page 1 was already read. */
  async function readPages(expr: string, total: number): Promise<void> {
    const wanted = Math.min(MAX_PAGES, Math.ceil(total / PAGE_SIZE)) - 1;
    const pages = Math.max(0, Math.min(wanted, budget.left));
    budget.left -= pages;
    if (total > MAX_RESULTS || pages < wanted) complete = false;
    const rest = await Promise.all(Array.from({ length: pages }, (_, i) => fetchPage(expr, i + 2)));
    for (const page of rest) {
      if (page.status === 'ok') add(page.tickets);
      else {
        failedRequests += 1;
        complete = false;
      }
    }
  }

  async function readWindow(range: DayRange): Promise<void> {
    if (budget.left < 1) {
      complete = false;
      return;
    }
    budget.left -= 1;
    const expr = createdWithin(expression, range);
    const probe = await fetchPage(expr, 1);
    if (probe.status !== 'ok') {
      failedRequests += 1;
      complete = false;
      return;
    }
    add(probe.tickets);
    const halves = probe.total > MAX_RESULTS ? bisectDays(range) : null;
    if (!halves) return readPages(expr, probe.total);
    for (const half of halves) await readWindow(half);
  }

  add(first.tickets);
  if (first.total <= MAX_RESULTS) await readPages(expression, first.total);
  else
    for (const half of bisectDays({ from: EARLIEST_DAY, to: addDays(today, 1) }) ?? [])
      await readWindow(half);

  return {
    status: 'ok',
    tickets: [...found.values()],
    total: first.total,
    complete,
    failedRequests,
  };
}

/** What to tell the operator about a read that came back short without a failed request. */
export function shortReadWarning(label: string, res: Extract<Searched, { status: 'ok' }>): string {
  return res.total === null
    ? `${label} were not read (request budget spent); open Freshdesk for these.`
    : `Showing ${res.tickets.length} of ${res.total} ${label}; the rest is in Freshdesk.`;
}

/**
 * A short-lived memo of in-flight and finished loads. A rejected or incomplete load is dropped, so the
 * next call retries instead of being served the failure.
 */
export function createLoadCache<T>(
  ttlMs: number,
  isKeepable: (value: T) => boolean,
  now: () => number = Date.now
) {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const entry = { at: now(), value: load() };
    entries.set(key, entry);
    const evict = () => {
      if (entries.get(key) === entry) entries.delete(key);
    };
    entry.value.then((v) => isKeepable(v) || evict(), evict);
    return entry.value;
  };
}
