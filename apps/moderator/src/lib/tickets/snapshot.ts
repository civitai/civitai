import { LIVE_STATUSES } from './statuses';

/** One live ticket as the snapshot keeps it: what routing, sorting and search need, never a body. */
export type TicketRecord = {
  id: string;
  subject: string;
  status: number;
  cfFeature: string | null;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
  /** Only tickets that came through a delta or a detail read carry the requester. */
  requesterName?: string | null;
  /** 🔴 The customer's address. The query layer strips it unless the caller holds the PII grant. */
  requesterEmail?: string | null;
  /** Router topic; `undefined` until the router was asked, `null` when it had none. */
  routerTopic?: string | null;
  civitaiUserId?: number | null;
  /** Epoch ms of the router lookup that set `routerTopic`. */
  enrichedAt?: number;
};

/** A ticket from the changed-since list. `gone`: deleted or spam, which a live view never shows. */
export type ChangedTicket = TicketRecord & { gone?: boolean };

export type Snapshot = {
  tickets: TicketRecord[];
  /** Epoch ms the newest successful sync STARTED, so what changed while it ran is read next time. */
  syncedAt: number;
  /** Epoch ms of the last attempt, successful or not; throttles retries. */
  attemptedAt: number;
  fullAt: number;
  /** A delta overflowed or a full read came back short: rebuild once the retry interval has passed. */
  needsFull: boolean;
  /** What the last full read could not list, to show above the views. */
  readWarnings: string[];
  routerFailed: boolean;
  /** Why the newest refresh failed; cleared by the next success. */
  lastError: string | null;
};

const MIN = 60_000;
const HOUR = 60 * MIN;

export const SNAPSHOT_TIMING = {
  /** Status searches are the only way to list every live ticket, and cost 30+ calls of a shared 100/minute. */
  fullRebuildMs: 6 * HOUR,
  deltaMinMs: MIN,
  /** Freshdesk's search index and clocks lag a little; a ticket changed in this gap is read twice, never missed. */
  deltaOverlapMs: 5 * MIN,
  /** Past this a delta would read a long tail of changes, and a full rebuild is the cheaper way back. */
  deltaMaxAgeMs: 12 * HOUR,
  fullRetryMs: 5 * MIN,
  enrichRetryMs: 10 * MIN,
  staleWarnMs: 5 * MIN,
} as const;

export const isLiveStatus = (status: number): boolean => LIVE_STATUSES.includes(status);

export type RefreshKind = 'full' | 'delta' | 'none';

/** What a read should trigger. Pure, so the intervals are testable without a clock. */
export function decideRefresh(snapshot: Snapshot | null, now: number): RefreshKind {
  if (!snapshot) return 'full';
  const sinceAttempt = now - snapshot.attemptedAt;
  if (sinceAttempt < SNAPSHOT_TIMING.deltaMinMs) return 'none';
  if (snapshot.needsFull) return sinceAttempt >= SNAPSHOT_TIMING.fullRetryMs ? 'full' : 'none';
  if (now - snapshot.fullAt >= SNAPSHOT_TIMING.fullRebuildMs) return 'full';
  return now - snapshot.syncedAt >= SNAPSHOT_TIMING.deltaMaxAgeMs ? 'full' : 'delta';
}

/** The `updated_since` value for a delta after a sync that started at `syncedAt`. */
export const deltaSince = (syncedAt: number): string =>
  new Date(syncedAt - SNAPSHOT_TIMING.deltaOverlapMs).toISOString();

const REMEMBERED = [
  'requesterName',
  'requesterEmail',
  'routerTopic',
  'civitaiUserId',
  'enrichedAt',
] as const;

/** `fresh` with whatever `previous` knew that a fresh read does not carry. */
function withMemory(previous: TicketRecord | undefined, fresh: TicketRecord): TicketRecord {
  if (!previous) return fresh;
  const out: TicketRecord = { ...fresh };
  for (const key of REMEMBERED) {
    if (out[key] === undefined && previous[key] !== undefined)
      Object.assign(out, { [key]: previous[key] });
  }
  return out;
}

/** Applies a changed-since read: updates, drops what is no longer live, adds what is new. */
export function mergeDelta(
  current: readonly TicketRecord[],
  changed: readonly ChangedTicket[]
): TicketRecord[] {
  const newest = new Map<string, ChangedTicket>();
  for (const c of changed) {
    const seen = newest.get(c.id);
    if (!seen || (c.updatedAt ?? '') >= (seen.updatedAt ?? '')) newest.set(c.id, c);
  }
  const byId = new Map(current.map((t) => [t.id, t]));
  for (const [id, { gone, ...ticket }] of newest) {
    if (gone || !isLiveStatus(ticket.status)) byId.delete(id);
    else byId.set(id, withMemory(byId.get(id), ticket));
  }
  return [...byId.values()];
}

/** A fresh full read with the enrichment of the previous snapshot, so a rebuild does not re-ask the router. */
export function carryOver(
  previous: readonly TicketRecord[],
  fresh: readonly TicketRecord[]
): TicketRecord[] {
  const before = new Map(previous.map((t) => [t.id, t]));
  return fresh.map((t) => withMemory(before.get(t.id), t));
}

/**
 * The router matters twice: for the account link of every ticket, and for the topic of a ticket with
 * no feature. Silence is retried for the second kind only, since a router that has not seen a new
 * ticket yet will.
 */
export function needsEnrichment(record: TicketRecord, now: number): boolean {
  if (record.enrichedAt === undefined) return true;
  if (record.routerTopic || record.cfFeature) return false;
  return now - record.enrichedAt >= SNAPSHOT_TIMING.enrichRetryMs;
}

/** Whether `record`'s topic can be trusted without asking the router again. */
export const topicIsKnown = (record: TicketRecord | undefined, now: number): boolean =>
  !!record && !needsEnrichment(record, now);

export function applyEnrichment(
  record: TicketRecord,
  context: { topic: string | null; civitaiUserId: number | null } | undefined,
  now: number
): TicketRecord {
  return {
    ...record,
    routerTopic: context?.topic ?? null,
    civitaiUserId: context?.civitaiUserId ?? null,
    enrichedAt: now,
  };
}

/** What the operator should be told about the snapshot's health, to show above the views. */
export function snapshotWarnings(snapshot: Snapshot, now: number): string[] {
  const out = [...snapshot.readWarnings];
  if (snapshot.routerFailed)
    out.push(
      'The ticket router could not be read, so tickets without a feature are shown in the support view whatever they are about.'
    );
  if (snapshot.lastError && now - snapshot.syncedAt >= SNAPSHOT_TIMING.staleWarnMs) {
    const minutes = Math.max(1, Math.round((now - snapshot.syncedAt) / MIN));
    out.push(
      `Tickets may be out of date: the last refresh failed (${snapshot.lastError}) and the data is ${minutes} min old.`
    );
  }
  return out;
}
