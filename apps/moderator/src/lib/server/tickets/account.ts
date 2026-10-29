import { sql } from '@civitai/db/kysely';
import { dbRead } from '../db';
import { getTimedMute } from '../user-actions.service';
import { getIdentity } from '../user-lookup.service';
import { accountPanelFor } from '$lib/tickets/account-panel';
import { unwiredRulingReason } from '$lib/restriction-types';
import type { TicketView } from '$lib/tickets/routing';

/** The restriction rows shown on the card: open ones first, then the latest. */
const RESTRICTION_ROWS = 5;

export type TicketRestriction = {
  id: number;
  type: string;
  status: string;
  createdAt: string;
  /** Open and of a type the main app can rule on: the only rows the card offers a ruling for. */
  rulable: boolean;
};

export type TicketAccount =
  | { status: 'unlinked' }
  | { status: 'unavailable'; userId: number }
  | {
      status: 'ok';
      userId: number;
      username: string | null;
      banned: { since: string | null; reason: string | null } | null;
      muted: boolean;
      timedMute: { until: string; source: string; reason: string | null } | null;
      restrictions: TicketRestriction[];
    };

type RestrictionRow = { id: number; type: string; status: string; createdAt: Date };

export type AccountReads = {
  identity: typeof getIdentity;
  timedMute: typeof getTimedMute;
  restrictions: (userId: number) => Promise<RestrictionRow[]>;
};

const liveReads: AccountReads = {
  identity: getIdentity,
  timedMute: getTimedMute,
  restrictions: (userId) =>
    dbRead
      .selectFrom('UserRestriction')
      .select(['id', 'type', 'status', 'createdAt'])
      .where('userId', '=', userId)
      .orderBy(sql`(status = 'Pending') DESC NULLS LAST`)
      .orderBy('id', 'desc')
      .limit(RESTRICTION_ROWS)
      .execute(),
};

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * The account section of a ticket payload. `undefined` leaves the key out: the viewer may not open
 * User Lookup (the page whose data this is), or the ticket is not an account ticket. A failed read is
 * `unavailable` and never fails the ticket. The address is never copied out of the identity read.
 */
export async function accountSectionFor(
  ticket: {
    view: TicketView;
    cfFeature: string | null;
    routerTopic: string | null;
    civitaiUserId: number | null;
    canView: boolean;
  },
  reads: AccountReads = liveReads
): Promise<TicketAccount | undefined> {
  if (!ticket.canView) return undefined;
  const panel = accountPanelFor(ticket);
  if (panel === 'hidden') return undefined;
  if (panel === 'unlinked' || ticket.civitaiUserId === null) return { status: 'unlinked' };

  const userId = ticket.civitaiUserId;
  try {
    const [identity, timed, restrictions] = await Promise.all([
      reads.identity(userId),
      reads.timedMute(userId),
      reads.restrictions(userId),
    ]);
    if (!identity) return { status: 'unavailable', userId };
    return {
      status: 'ok',
      userId,
      username: identity.username,
      banned: identity.bannedAt
        ? { since: iso(identity.bannedAt), reason: identity.banReason }
        : null,
      muted: !!identity.muted,
      timedMute: timed
        ? { until: iso(timed.muteExpiresAt)!, source: timed.source, reason: timed.reason }
        : null,
      restrictions: restrictions.map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        createdAt: iso(r.createdAt)!,
        rulable: r.status === 'Pending' && unwiredRulingReason(r.type) === null,
      })),
    };
  } catch (e) {
    console.error('[tickets] account status failed', e);
    return { status: 'unavailable', userId };
  }
}
