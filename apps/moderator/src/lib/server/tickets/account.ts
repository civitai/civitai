import { sql } from '@civitai/db/kysely';
import { dbRead } from '../db';
import { getTimedMute } from '../user-actions.service';
import { getIdentity } from '../user-lookup.service';
import { accountPanelFor } from '$lib/tickets/account-panel';
import { supportAccountPanelFor } from '$lib/tickets/support-account-panel';
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
      /** The user's latest pending Account site appeal; present only for a viewer who may open `/appeals/account`. */
      pendingAppeal?: TicketAccountAppeal | null;
      /** Read-only (support) card only: how the user signs in and whether the address was ever verified. */
      email?: string | null;
      emailVerified?: string | null;
    };

export type TicketAccountAppeal = { id: number; createdAt: string; message: string };

type RestrictionRow = { id: number; type: string; status: string; createdAt: Date };

export type AccountReads = {
  identity: typeof getIdentity;
  timedMute: typeof getTimedMute;
  restrictions: (userId: number) => Promise<RestrictionRow[]>;
  /** The user's latest pending Account appeal: one bounded row off the userId index. */
  pendingAppeal: (
    userId: number
  ) => Promise<{ id: number; createdAt: Date; appealMessage: string } | null>;
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
  pendingAppeal: async (userId) =>
    (await dbRead
      .selectFrom('Appeal')
      .select(['id', 'createdAt', 'appealMessage'])
      .where('userId', '=', userId)
      .where('category', '=', 'Account')
      .where('status', '=', 'Pending')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()) ?? null,
};

/** A failed appeal read costs only the appeal, never the account status beside it. */
async function pendingAppealOf(
  reads: AccountReads,
  userId: number
): Promise<TicketAccountAppeal | null> {
  try {
    const found = await reads.pendingAppeal(userId);
    return found
      ? { id: found.id, createdAt: iso(found.createdAt)!, message: found.appealMessage }
      : null;
  } catch (e) {
    console.error('[tickets] account appeal read failed', e);
    return null;
  }
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * The account section of a ticket payload. `undefined` leaves the key out: the viewer may not open
 * User Lookup (the page whose data this is), or the ticket is not an account ticket. A failed read is
 * `unavailable` and never fails the ticket. `readOnly` is the support card: its own visibility rule, no
 * appeal and no rulable restriction, and the only place the address (behind the PII grant) and its verified date are copied out.
 */
export async function accountSectionFor(
  ticket: {
    view: TicketView;
    cfFeature: string | null;
    routerTopic: string | null;
    civitaiUserId: number | null;
    canView: boolean;
    /** The viewer may open `/appeals/account`, so a pending Account appeal is read and ruled here. */
    canAppeal?: boolean;
    readOnly?: boolean;
    /** The viewer holds `decisions.support.pii`; without it the read-only card carries no address. */
    canSeeEmail?: boolean;
  },
  reads: AccountReads = liveReads
): Promise<TicketAccount | undefined> {
  if (!ticket.canView) return undefined;
  const { readOnly = false, canSeeEmail = false } = ticket;
  const panel = readOnly ? supportAccountPanelFor(ticket) : accountPanelFor(ticket);
  if (panel === 'hidden') return undefined;
  if (panel === 'unlinked' || ticket.civitaiUserId === null) return { status: 'unlinked' };

  const userId = ticket.civitaiUserId;
  try {
    const [identity, timed, restrictions, appeal] = await Promise.all([
      reads.identity(userId),
      reads.timedMute(userId),
      reads.restrictions(userId),
      ticket.canAppeal && !readOnly ? pendingAppealOf(reads, userId) : undefined,
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
        rulable: !readOnly && r.status === 'Pending' && unwiredRulingReason(r.type) === null,
      })),
      ...(appeal === undefined ? {} : { pendingAppeal: appeal }),
      ...(readOnly
        ? {
            ...(canSeeEmail ? { email: identity.email ?? null } : {}),
            emailVerified: iso(identity.emailVerified),
          }
        : {}),
    };
  } catch (e) {
    console.error('[tickets] account status failed', e);
    return { status: 'unavailable', userId };
  }
}
