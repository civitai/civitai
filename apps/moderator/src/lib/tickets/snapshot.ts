import { LIVE_STATUSES } from './statuses';

/** One live ticket as the snapshot keeps it, never with a body. */
export type TicketRecord = {
  id: string;
  subject: string;
  status: number;
  cfFeature: string | null;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
  /** Only tickets from a delta or a detail read carry the name (full reads don't), so name search misses the rest. The address is never stored: personal data stays out of the shared cache. */
  requesterName?: string | null;
  /** Router topic; `undefined` until the router was asked, `null` when it had none. */
  routerTopic?: string | null;
  civitaiUserId?: number | null;
  /** Epoch ms of the router lookup. */
  enrichedAt?: number;
  /** Consecutive short full reads that did not list this ticket; at `maxMissedFulls` it is dropped. */
  missedFulls?: number;
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
  /** Newest failed full rebuild; holds off the next one while deltas continue. Cleared by a successful full read. */
  fullFailedAt?: number;
  /** What the last full read could not list, to show above the views. */
  readWarnings: string[];
  routerFailed: boolean;
  /** Why the newest refresh failed; cleared by the next success. */
  lastError: string | null;
};

const MIN = 60_000;
const HOUR = 60 * MIN;

export const SNAPSHOT_TIMING = {
  /** Status searches are the only way to list every live ticket, and spend many calls of the shared Freshdesk rate limit. */
  fullRebuildMs: 6 * HOUR,
  deltaMinMs: MIN,
  /** Freshdesk's search index and clocks lag a little; a ticket changed in this gap is read twice, never missed. */
  deltaOverlapMs: 5 * MIN,
  /** Past this a delta would read a long tail of changes, and a full rebuild is the cheaper way back. */
  deltaMaxAgeMs: 12 * HOUR,
  fullRetryMs: 5 * MIN,
  /** A ticket that this many consecutive short full reads did not list is taken to have closed. */
  maxMissedFulls: 3,
  enrichRetryMs: 10 * MIN,
  staleWarnMs: 5 * MIN,
} as const;

export const isLiveStatus = (status: number): boolean => LIVE_STATUSES.includes(status);

export type RefreshKind = 'full' | 'delta' | 'none';

export function decideRefresh(snapshot: Snapshot | null, now: number): RefreshKind {
  if (!snapshot) return 'full';
  const sinceAttempt = now - snapshot.attemptedAt;
  if (sinceAttempt < SNAPSHOT_TIMING.deltaMinMs) return 'none';
  if (snapshot.needsFull) return sinceAttempt >= SNAPSHOT_TIMING.fullRetryMs ? 'full' : 'none';
  const tooOldForDelta = now - snapshot.syncedAt >= SNAPSHOT_TIMING.deltaMaxAgeMs;
  if (tooOldForDelta || now - snapshot.fullAt >= SNAPSHOT_TIMING.fullRebuildMs) {
    const retryHeld =
      snapshot.fullFailedAt !== undefined &&
      now - snapshot.fullFailedAt < SNAPSHOT_TIMING.fullRetryMs;
    if (!retryHeld) return 'full';
    return tooOldForDelta ? 'none' : 'delta';
  }
  return 'delta';
}

export const deltaSince = (syncedAt: number): string =>
  new Date(syncedAt - SNAPSHOT_TIMING.deltaOverlapMs).toISOString();

const REMEMBERED = ['requesterName', 'routerTopic', 'civitaiUserId', 'enrichedAt'] as const;

/** Only the record's own fields, so anything else a read carried (the requester's address on the changed-since list) never reaches the cache. */
function pickRecord(t: TicketRecord): TicketRecord {
  const out: TicketRecord = {
    id: t.id,
    subject: t.subject,
    status: t.status,
    cfFeature: t.cfFeature,
    tags: t.tags,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
  for (const key of REMEMBERED) {
    if (t[key] !== undefined) Object.assign(out, { [key]: t[key] });
  }
  return out;
}

/** `read` plus whatever `previous` knew that a read does not carry. */
function withMemory(previous: TicketRecord | undefined, read: TicketRecord): TicketRecord {
  const fresh = pickRecord(read);
  if (!previous) return fresh;
  const out: TicketRecord = fresh;
  for (const key of REMEMBERED) {
    if (out[key] === undefined && previous[key] !== undefined)
      Object.assign(out, { [key]: previous[key] });
  }
  return out;
}

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

/** A short full read cannot say what closed: unlisted tickets are kept until `maxMissedFulls` reads in a row miss them. */
export function mergeShortRead(
  current: readonly TicketRecord[],
  read: readonly TicketRecord[]
): TicketRecord[] {
  const listed = new Set(read.map((t) => t.id));
  const kept = current.flatMap((t) => {
    if (listed.has(t.id)) return [];
    const missedFulls = (t.missedFulls ?? 0) + 1;
    return missedFulls >= SNAPSHOT_TIMING.maxMissedFulls ? [] : [{ ...t, missedFulls }];
  });
  const before = new Map(current.map((t) => [t.id, t]));
  return [...kept, ...read.map((t) => withMemory(before.get(t.id), t))];
}

/** A full read, keeping what the previous snapshot knew (enrichment, requester name). */
export function carryOver(
  previous: readonly TicketRecord[],
  fresh: readonly TicketRecord[]
): TicketRecord[] {
  const before = new Map(previous.map((t) => [t.id, t]));
  return fresh.map((t) => withMemory(before.get(t.id), t));
}

/** Settled once the router gave a topic (or the ticket has a feature) and an account link; until then it is asked again every `enrichRetryMs`, because the router may not have seen a new ticket yet. */
export function needsEnrichment(record: TicketRecord, now: number): boolean {
  if (record.enrichedAt === undefined) return true;
  if ((record.routerTopic || record.cfFeature) && record.civitaiUserId != null) return false;
  return now - record.enrichedAt >= SNAPSHOT_TIMING.enrichRetryMs;
}

/** Whether the router need not be asked again for `record`: it answered fully, or was asked within `enrichRetryMs`. */
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
