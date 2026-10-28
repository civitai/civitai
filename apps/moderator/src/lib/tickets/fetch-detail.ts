import { fetchJson } from '$lib/fetch-json';
import type { TicketPayload } from '$lib/server/tickets/detail';
import type { TicketView } from './routing';

/** The open ticket's description and conversation. Rejects with the endpoint's message when it refuses. */
export const fetchTicketPayload = (id: string, view: TicketView): Promise<TicketPayload> =>
  fetchJson<TicketPayload>(`/api/tickets/${encodeURIComponent(id)}?view=${view}`);

/**
 * What a detail read settles to. It never rejects: a failed read of a ticket already on screen keeps that
 * ticket's last read with `stale` naming why it is not fresh.
 */
export type DetailResult =
  | { ok: true; payload: TicketPayload; stale: string | null }
  | { ok: false; message: string };

/** Moving through the list with J/K passes many tickets a second; only the one that settles is read. */
export const DETAIL_SETTLE_MS = 300;

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : 'Freshdesk could not be read.';

/**
 * Reads ticket details for one pane. The first read, and a read of a different ticket than the last, waits
 * `settleMs` and is dropped if another read or `cancel` comes first; a re-read of the same ticket (after a
 * write) starts at once. The list remounts the pane per selected ticket, so `cancel` on destroy is what
 * stops a ticket the moderator already moved past from being read.
 */
export function createDetailLoader(
  fetchPayload: (id: string, view: TicketView) => Promise<TicketPayload> = fetchTicketPayload,
  settleMs: number = DETAIL_SETTLE_MS
) {
  let lastId: string | null = null;
  let lastGood: { id: string; payload: TicketPayload } | null = null;
  let cancelPending: (() => void) | null = null;

  const read = async (id: string, view: TicketView): Promise<DetailResult> => {
    try {
      const payload = await fetchPayload(id, view);
      lastGood = { id, payload };
      return { ok: true, payload, stale: null };
    } catch (e) {
      const message = errorMessage(e);
      return lastGood?.id === id
        ? { ok: true, payload: lastGood.payload, stale: message }
        : { ok: false, message };
    }
  };

  const cancel = () => {
    cancelPending?.();
    cancelPending = null;
  };

  const load = (id: string, view: TicketView): Promise<DetailResult> => {
    cancel();
    const changed = id !== lastId;
    lastId = id;
    if (!changed || settleMs <= 0) return read(id, view);
    return new Promise<DetailResult>((resolve) => {
      const timer = setTimeout(() => {
        cancelPending = null;
        resolve(read(id, view));
      }, settleMs);
      cancelPending = () => {
        clearTimeout(timer);
        resolve({ ok: false, message: 'Superseded by a newer selection.' });
      };
    });
  };

  return { load, cancel };
}
