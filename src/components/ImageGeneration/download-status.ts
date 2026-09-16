import type { ResourceLoadAvailability } from '~/server/schema/resource-load.schema';
import { formatDownloadEtaShort } from '~/components/ResourceLoad/download-eta';

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

export function describeDownload({ progress, queuePosition, etaSeconds }: DownloadRow) {
  const eta = etaSeconds != null ? ` · ~${formatDownloadEtaShort(etaSeconds)}` : '';
  if (progress != null) return `Downloading ${Math.round(progress * 100)}%${eta}`;
  if (queuePosition != null) return `#${queuePosition + 1} in queue${eta}`;
  return 'Waiting to start';
}
