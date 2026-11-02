// A viewer's App Blocks document-store usage in one app, against the per-viewer ceiling
// (`userBytes` / `userDocs`). The one place that decides "near the limit", shared by the
// account-settings card and the running app's notice so the two cannot disagree.

/** Stored usage, in the store's unit (bytes of the canonical JSON text) and documents. */
export type StorageFigure = { bytes: number; docs: number };

/** The per-viewer ceilings of one (app, namespace, user). */
export type ViewerStorageLimits = { userBytes: number; userDocs: number };

/** From this fraction of either ceiling, the viewer is told they are close to it. */
export const APP_STORAGE_NEAR_LIMIT_RATIO = 0.8;

/** The fuller of the two ceilings, as a fraction (can exceed 1 after a ceiling was lowered). */
export function storageUsageRatio(usage: StorageFigure, limits: ViewerStorageLimits): number {
  const of = (used: number, limit: number) => (limit > 0 ? used / limit : 0);
  return Math.max(of(usage.bytes, limits.userBytes), of(usage.docs, limits.userDocs));
}

export function isNearStorageLimit(usage: StorageFigure, limits: ViewerStorageLimits): boolean {
  void storageUsageRatio(usage, limits);
  return false; // STUB: tests-first commit
}

/** A whole percentage for a bar, clamped to 0–100. */
export function storagePercent(used: number, limit: number): number {
  void used;
  void limit;
  return 0; // STUB: tests-first commit
}
