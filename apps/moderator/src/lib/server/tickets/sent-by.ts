import { dbRead } from '../db';
import { withModerators } from '../mod-activity';
import { latestPerTicket } from '$lib/tickets/sent-by';

export type SentBy = { moderatorId: number | null; username: string | null; at: string };

/**
 * Who sent each ticket to support, from the newest `ticketEscalate` ModActivity row. A ticket tagged by
 * hand has no row. Rejects when the read fails; an empty map means nobody is on record.
 */
export async function sentByTickets(ticketIds: readonly string[]): Promise<Map<string, SentBy>> {
  const ids = ticketIds.map(Number).filter(Number.isSafeInteger);
  if (!ids.length) return new Map();
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
}
