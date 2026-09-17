import type { ResourceLoadAvailability } from '~/server/schema/resource-load.schema';
import { formatDownloadEtaShort } from '~/components/ResourceLoad/download-eta';
import { parseAIRSafe } from '~/shared/utils/air';

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

/** The model version an AIR names, or undefined — a non-Civitai AIR's version need not be a number. */
export function versionIdFromAir(air: string) {
  const version = parseAIRSafe(air)?.version;
  return version && Number.isSafeInteger(version) && version > 0 ? version : undefined;
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
  const etaSeconds = maxKnown(rows.map((r) => r.etaSeconds));
  const gating =
    rows.find((r) => etaSeconds != null && r.etaSeconds === etaSeconds) ??
    rows.find((r) => r.lane) ??
    rows[0];
  const transferring = gating.progress != null;
  return {
    lane: gating.lane,
    transferring,
    queuePosition: transferring ? 0 : gating.queuePosition ?? null,
    etaSeconds,
    boostedEtaSeconds: maxKnown(rows.map((r) => r.boostedEtaSeconds)),
    rateLimitBytesPerSecond: gating.rateLimitBytesPerSecond,
    totalBytes: rows.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0),
    count: rows.length,
  };
}

/**
 * Whether a boost is worth offering. The two ETAs are measured at different moments — the boosted one
 * when the workflow queued, the plain one live — so a download that has since sped up can quote a
 * "boost" that is slower than the current wait.
 */
export function isWorthBoosting(
  summary: DownloadSummary | undefined
): summary is DownloadSummary & { boostedEtaSeconds: number } {
  return (
    !!summary?.boostedEtaSeconds &&
    (summary.etaSeconds == null || summary.boostedEtaSeconds < summary.etaSeconds)
  );
}

export function describeDownload({ progress, queuePosition, etaSeconds }: DownloadRow) {
  const eta = etaSeconds != null ? ` · ~${formatDownloadEtaShort(etaSeconds)}` : '';
  if (progress != null) return `Downloading ${Math.round(progress * 100)}%${eta}`;
  if (queuePosition != null) return `#${queuePosition + 1} in queue${eta}`;
  return 'Waiting to start';
}
