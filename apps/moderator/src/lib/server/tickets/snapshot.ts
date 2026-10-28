import { getRedis } from '../redis';
import { getRoutedTicketContext } from '../decision-sources/support';
import { listTicketsUpdatedSince, searchTickets, type TicketSummary } from '../freshdesk.service';
import { readChanged, readLive } from './snapshot-reads';
import { createSnapshotService } from './snapshot-service';
import { createRedisSnapshotStore } from './snapshot-store';
import type { TicketRecord } from '$lib/tickets/snapshot';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The one shared snapshot of live tickets. The router is asked without the address, as everywhere else:
 * the address column is selected only for a caller holding the PII grant.
 */
export const ticketSnapshot = createSnapshotService({
  store: createRedisSnapshotStore(getRedis),
  fullRead: () => readLive(searchTickets, today()),
  deltaRead: (since) => readChanged(listTicketsUpdatedSince, since),
  enrich: async (ids) => {
    const context = await getRoutedTicketContext(ids, false);
    return new Map(
      [...context].map(([id, c]) => [id, { topic: c.topic, civitaiUserId: c.civitaiUserId }])
    );
  },
});

/** A ticket read from Freshdesk, as the snapshot holds it. */
export const toRecord = (
  t: TicketSummary & { requesterName?: string | null; requesterEmail?: string | null }
): TicketRecord => ({
  id: t.id,
  subject: t.subject,
  status: t.status,
  cfFeature: t.cfFeature,
  tags: t.tags,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  requesterName: t.requesterName,
  requesterEmail: t.requesterEmail,
});
