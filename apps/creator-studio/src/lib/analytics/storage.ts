export type StorageRow = {
  kind: string;
  publicStatus: string;
  baseModel: string;
  /** `YYYY-MM-DD`, first day of the upload month. */
  month: string;
  fileCount: number;
  bytes: number;
};

export type StorageRollupState = {
  requestedAt: string | null;
  computedAt: string | null;
};

export const STORAGE_KIND_ORDER = [
  'model',
  'training',
  'image',
  'video',
  'audio',
  'model3d',
  'attachment',
] as const;

export const STORAGE_KIND_LABELS: Record<string, string> = {
  model: 'Model files',
  training: 'Training data',
  image: 'Images',
  video: 'Videos',
  audio: 'Audio',
  model3d: '3D models',
  attachment: 'Other files',
};

export const TOP_BASE_MODELS = 10;
export const MEDIA_STALE_MS = 24 * 60 * 60 * 1000;

export type StorageTotal = { bytes: number; fileCount: number };
export type StorageKindTotal = StorageTotal & { kind: string; label: string };
export type StorageBaseModel = StorageTotal & { baseModel: string };
export type StorageMonth = { month: string; bytesByKind: Record<string, number> };

export type StorageSummary = {
  total: StorageTotal;
  notPublic: StorageTotal;
  byKind: StorageKindTotal[];
  baseModels: StorageBaseModel[];
  /** Summed bytes of the base models past the top ten, or null when there are none. */
  otherBaseModels: StorageTotal | null;
  months: StorageMonth[];
  kinds: string[];
};

const add = (t: StorageTotal, r: StorageRow) => {
  t.bytes += r.bytes;
  t.fileCount += r.fileCount;
};

const kindRank = (kind: string) => {
  const i = (STORAGE_KIND_ORDER as readonly string[]).indexOf(kind);
  return i === -1 ? STORAGE_KIND_ORDER.length : i;
};

/**
 * Everything except `notPublic` counts public rows only, so the headline, the charts and the table under
 * them always add up to the same figure.
 */
export function summarizeStorage(rows: StorageRow[]): StorageSummary {
  const total: StorageTotal = { bytes: 0, fileCount: 0 };
  const notPublic: StorageTotal = { bytes: 0, fileCount: 0 };
  const kinds = new Map<string, StorageTotal>();
  const bases = new Map<string, StorageTotal>();
  const months = new Map<string, Record<string, number>>();

  for (const r of rows) {
    if (r.publicStatus !== 'public') {
      add(notPublic, r);
      continue;
    }
    add(total, r);

    const k = kinds.get(r.kind) ?? { bytes: 0, fileCount: 0 };
    add(k, r);
    kinds.set(r.kind, k);

    if (r.kind === 'model') {
      const name = r.baseModel || 'Unknown';
      const b = bases.get(name) ?? { bytes: 0, fileCount: 0 };
      add(b, r);
      bases.set(name, b);
    }

    const m = months.get(r.month) ?? {};
    m[r.kind] = (m[r.kind] ?? 0) + r.bytes;
    months.set(r.month, m);
  }

  const byKind = [...kinds.entries()]
    .map(([kind, t]) => ({ kind, label: STORAGE_KIND_LABELS[kind] ?? kind, ...t }))
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind));

  const sortedBases = [...bases.entries()]
    .map(([baseModel, t]) => ({ baseModel, ...t }))
    .sort((a, b) => b.bytes - a.bytes);
  const rest = sortedBases.slice(TOP_BASE_MODELS);
  const otherBaseModels = rest.length
    ? rest.reduce(
        (acc, b) => ({ bytes: acc.bytes + b.bytes, fileCount: acc.fileCount + b.fileCount }),
        {
          bytes: 0,
          fileCount: 0,
        }
      )
    : null;

  return {
    total,
    notPublic,
    byKind,
    baseModels: sortedBases.slice(0, TOP_BASE_MODELS),
    otherBaseModels,
    months: [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, bytesByKind]) => ({ month, bytesByKind })),
    kinds: byKind.map((k) => k.kind),
  };
}

/**
 * What the page shows when the rollup has no rows. `overnight` is a creator whose uploads exist (the live
 * per-model table lists them) but postdate the last nightly run, so "nothing here" would be false.
 */
export function storageEmptyKind(
  summary: StorageSummary,
  liveModelCount: number
): 'none' | 'overnight' | null {
  if (summary.total.fileCount > 0 || summary.notPublic.fileCount > 0) return null;
  return liveModelCount > 0 ? 'overnight' : 'none';
}

/** True while the images/videos half is missing or a refresh is queued behind the last completed one. */
export function isMediaCalculating(state: StorageRollupState | null): boolean {
  if (!state?.computedAt) return true;
  return !!state.requestedAt && state.requestedAt > state.computedAt;
}

/** Whether a page view should queue a refresh: never computed, or last computed over 24h ago. */
export function needsMediaRefresh(state: StorageRollupState | null, now = Date.now()): boolean {
  if (!state?.computedAt) return !state?.requestedAt;
  if (state.requestedAt && state.requestedAt > state.computedAt) return false;
  return now - Date.parse(state.computedAt) > MEDIA_STALE_MS;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value >= 100 || exp === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[exp]}`;
}
