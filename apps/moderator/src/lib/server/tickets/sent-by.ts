import { dbRead } from '../db';
import { withModerators } from '../mod-activity';
import { latestPerTicket } from '$lib/tickets/sent-by';

export type SentBy = { moderatorId: number | null; username: string | null; at: string };

/**
 * Who sent each of these tickets to support, from the newest `ticketEscalate` ModActivity row, read with
 * one query and one user read for the whole list. A ticket tagged by hand in Freshdesk has no row, so it
 * is simply absent from the map. Best-effort: a failed read logs and returns an empty map, so the list
 * shows "Sent to support" without a name rather than failing.
 */
export async function sentByTickets(ticketIds: readonly string[]): Promise<Map<string, SentBy>> {
  const ids = ticketIds.map(Number).filter(Number.isSafeInteger);
  if (!ids.length) return new Map();
  try {
    const rows = await dbRead
      .selectFrom('ModActivity')
      .select(['entityId', 'userId', 'createdAt'])
      .where('entityType', '=', 'ticket')
      .where('activity', '=', 'ticketEscalate')
      .where('entityId', 'in', ids)
      .execute();
    const latest = latestPerTicket(rows);
    const named = await withModerators(
      [...latest].map(([ticketId, e]) => ({ ticketId, userId: e.moderatorId, at: e.at }))
    );
    return new Map(
      named.map((r) => [
        r.ticketId,
        { moderatorId: r.moderatorId, username: r.moderatorUsername, at: r.at },
      ])
    );
  } catch (e) {
    console.error('[tickets] sent-by lookup failed', e);
    return new Map();
  }
}
