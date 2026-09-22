import type { ResourceLoadAvailability } from '~/server/schema/resource-load.schema';
import { DOWNLOAD_STATUS_MAX_IDS } from '~/server/schema/resource-load.schema';
import {
  boostBuysVisibleTime,
  formatDownloadEtaShort,
} from '~/components/ResourceLoad/download-eta';
import {
  settledBoostedEtaSeconds,
  settledEtaSeconds,
} from '~/shared/orchestrator/download-preparation';
import { versionIdFromAir } from '~/shared/utils/air';

/** One model's download, as the queue card shows it. */
export type DownloadRow = {
  lane?: string | null;
  /** 0..1 while transferring. */
  progress?: number | null;
  /** Downloads ahead; shown from 1. */
  queuePosition?: number | null;
  etaSeconds?: number | null;
  boostedEtaSeconds?: number | null;
  /** The lane's per-download cap. Null when uncapped. */
  rateLimitBytesPerSecond?: number | null;
  sizeBytes?: number | null;
};

/** A generation's downloads, told through the one holding it back. */
export type DownloadSummary = {
  lane?: string | null;
  transferring: boolean;
  /** Downloads ahead of the slowest model; null before it is queued. */
  queuePosition: number | null;
  etaSeconds: number | null;
  /** From the workflow's preparation at queue time; `etaSeconds` is live, so this is the staler of the two. */
  boostedEtaSeconds: number | null;
  rateLimitBytesPerSecond?: number | null;
  totalBytes: number;
  count: number;
};

/** Undefined for a model with nothing to download — loaded, unsupported, or unreadable. */
export function toDownloadRow(
  availability: ResourceLoadAvailability,
  sizeBytes?: number | null
): DownloadRow | undefined {
  switch (availability.status) {
    case 'loading':
      return {
        lane: availability.lane,
        progress: availability.progress,
        etaSeconds: availability.etaSeconds,
        rateLimitBytesPerSecond: availability.rateLimitBytesPerSecond,
        sizeBytes,
      };
    case 'queued':
      return {
        lane: availability.lane,
        queuePosition: availability.queuePosition,
        etaSeconds: availability.etaSeconds,
        boostedEtaSeconds: availability.boostedEtaSeconds,
        rateLimitBytesPerSecond: availability.rateLimitBytesPerSecond,
        sizeBytes,
      };
    case 'unavailable':
      return { queuePosition: availability.queuePosition, sizeBytes };
    default:
      return undefined;
  }
}

/**
 * One model's row from the workflow's own `preparation` and the model's shared live status.
 *
 * A download is shared by every workflow waiting on the model, so its live lane — and that lane's
 * cap and position — is whoever asked highest, not this workflow. Those come from `preparation`;
 * live status contributes only transfer progress and ETA, and says when the model has landed.
 */
export function mergeDownloadRow(
  prepared: DownloadRow | undefined,
  live: { availability: ResourceLoadAvailability; size?: number | null } | undefined
): DownloadRow | undefined {
  if (!live) return prepared;
  const row = toDownloadRow(live.availability, live.size);
  if (!row) return undefined;
  // Everything a shared download reports is about whoever asked highest, not this workflow — so
  // without preparation to read, only the facts that hold for every waiter survive.
  if (!prepared) return { progress: row.progress, sizeBytes: row.sizeBytes };
  return {
    ...prepared,
    progress: row.progress,
    etaSeconds: row.etaSeconds ?? prepared.etaSeconds,
    sizeBytes: prepared.sizeBytes ?? row.sizeBytes,
  };
}

type LiveStatus = {
  modelVersionId: number;
  availability: ResourceLoadAvailability;
  size?: number | null;
};

export function downloadPollIds(
  resourceIds: number[],
  preparation: { resources: { resource: string }[] } | undefined
) {
  const waitingOn =
    preparation?.resources
      .map((r) => versionIdFromAir(r.resource))
      .filter((id): id is number => id != null) ?? [];
  return (waitingOn.length ? waitingOn : resourceIds).slice(0, DOWNLOAD_STATUS_MAX_IDS);
}

/**
 * Gates the status poll and the rows together: a disabled query keeps its last response, so rows
 * built after the wait ends would freeze on that snapshot's progress.
 */
export function isAwaitingDownload(preparation: unknown, preparing: boolean) {
  return !!preparation || preparing;
}

export function buildDownloadRows<R extends { id: number }>({
  resources,
  preparation,
  preparing,
  live,
}: {
  resources: R[];
  preparation: { resources: (DownloadRow & { resource: string })[] } | undefined;
  preparing: boolean;
  live: LiveStatus[] | undefined;
}) {
  if (!isAwaitingDownload(preparation, preparing)) return [];

  return resources.flatMap((resource) => {
    const prepared = preparation?.resources.find(
      (r) => versionIdFromAir(r.resource) === resource.id
    );
    const row = mergeDownloadRow(
      prepared,
      live?.find((x) => x.modelVersionId === resource.id)
    );
    return row ? [{ resource, row }] : [];
  });
}

const maxKnown = (values: (number | null | undefined)[]) => {
  const known = values.filter((value): value is number => value != null);
  return known.length ? Math.max(...known) : null;
};

/**
 * The generation waits on every download, so it is told through the slowest: the longest ETA, or
 * failing that the first model already in a lane.
 */
export function summarizeDownloads(rows: DownloadRow[]): DownloadSummary | undefined {
  if (!rows.length) return undefined;
  const etaSeconds = maxKnown(rows.map(settledEtaSeconds));
  const gating =
    rows.find((r) => etaSeconds != null && settledEtaSeconds(r) === etaSeconds) ??
    rows.find((r) => r.progress != null) ??
    rows.find((r) => r.lane) ??
    rows[0];
  // Any transfer under way means the generation is not queued, whichever row ended up gating — a
  // warming resource loses gating to a settled one, and "#3 in queue" above "Downloading 1%" is a
  // card contradicting itself.
  const transferring = rows.some((r) => r.progress != null);
  return {
    lane: gating.lane,
    transferring,
    queuePosition: transferring ? 0 : gating.queuePosition ?? null,
    etaSeconds,
    boostedEtaSeconds: maxKnown(rows.map(settledBoostedEtaSeconds)),
    rateLimitBytesPerSecond: gating.rateLimitBytesPerSecond,
    totalBytes: rows.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0),
    count: rows.length,
  };
}

export function isWorthBoosting(
  summary: DownloadSummary | undefined
): summary is DownloadSummary & { boostedEtaSeconds: number } {
  return !!summary && boostBuysVisibleTime(summary.etaSeconds, summary.boostedEtaSeconds);
}

export function describeDownload(row: DownloadRow) {
  const { progress, queuePosition } = row;
  const etaSeconds = settledEtaSeconds(row);
  const eta = etaSeconds != null ? ` · ~${formatDownloadEtaShort(etaSeconds)}` : '';
  if (progress != null) return `Downloading ${Math.round(progress * 100)}%${eta}`;
  if (queuePosition != null) return `#${queuePosition + 1} in queue${eta}`;
  return 'Waiting to start';
}
