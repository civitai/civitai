import {
  type ChangedPage,
  type TicketSearchPage,
  type TicketSummary,
  type Unavailable,
} from '../freshdesk.service';
import { readAll, shortReadWarning, type Budget } from './search';
import { statusQuery } from '$lib/tickets/queries';
import type { ChangedTicket } from '$lib/tickets/snapshot';
import { LIVE_STATUSES, statusLabel } from '$lib/tickets/statuses';

/** Freshdesk calls one full rebuild may make; the account's rate limit is shared with other integrations. */
export const FULL_CALL_BUDGET = 80;

/** Pages of 100 read by one delta. More than this changed since the last sync means a rebuild is the better read. */
export const DELTA_MAX_PAGES = 5;

export type LiveRead =
  | { status: 'ok'; tickets: TicketSummary[]; complete: boolean; warnings: string[] }
  | Unavailable;

/** Every live ticket, one status search at a time. A status that comes back short is a warning, not a failure. */
export async function readLive(
  fetchPage: (expression: string, page: number) => Promise<TicketSearchPage>,
  today: string
): Promise<LiveRead> {
  const found = new Map<string, TicketSummary>();
  const warnings: string[] = [];
  const budget: Budget = { left: FULL_CALL_BUDGET };
  let complete = true;
  // Sequential: the searches draw on one shared budget and rate limit.
  for (const status of LIVE_STATUSES) {
    const label = `"${statusLabel(status)}" tickets`;
    const res = await readAll(statusQuery(status), fetchPage, budget, today);
    if (res.status !== 'ok') return res;
    for (const t of res.tickets) found.set(t.id, t);
    if (res.failedRequests > 0) {
      complete = false;
      warnings.push(
        `${res.failedRequests} Freshdesk request(s) failed while reading ${label}, so some are missing from this list. Reload to retry.`
      );
    } else if (!res.complete) {
      complete = false;
      warnings.push(shortReadWarning(label, res));
    }
  }
  return { status: 'ok', tickets: [...found.values()], complete, warnings };
}

export type ChangedRead =
  | { status: 'ok'; changed: ChangedTicket[]; complete: boolean }
  | Unavailable;

/** The tickets changed since `sinceIso`. Any failed page fails the read: a delta is applied whole or not at all. */
export async function readChanged(
  fetchPage: (sinceIso: string, page: number) => Promise<ChangedPage>,
  sinceIso: string
): Promise<ChangedRead> {
  const changed: ChangedTicket[] = [];
  for (let page = 1; page <= DELTA_MAX_PAGES; page++) {
    const res = await fetchPage(sinceIso, page);
    if (res.status !== 'ok') return res;
    changed.push(...res.tickets);
    if (!res.hasMore) return { status: 'ok', changed, complete: true };
  }
  return { status: 'ok', changed, complete: false };
}
