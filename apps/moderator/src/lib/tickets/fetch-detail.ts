import type { TicketPayload } from '$lib/server/tickets/detail';
import type { TicketView } from './routing';

/** The open ticket's description and conversation. Rejects with the endpoint's message when it refuses. */
export async function fetchTicketPayload(id: string, view: TicketView): Promise<TicketPayload> {
  const res = await fetch(`/api/tickets/${encodeURIComponent(id)}?view=${view}`);
  if (!res.ok) {
    const body: { message?: string } | null = await res.json().catch(() => null);
    throw new Error(body?.message ?? `The ticket could not be read (${res.status}).`);
  }
  return res.json();
}
