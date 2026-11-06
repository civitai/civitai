import { create } from 'zustand';

// Written only in the browser (by the fetch wrapper), so the server's module-scope copy stays 0.
export const useSiteAlertsVersionStore = create<{ version: number }>(() => ({ version: 0 }));

/**
 * Only a strictly greater version counts: an edge-cached response replays the header it was
 * cached with, and acting on an older one would refetch for nothing.
 */
export function noteSiteAlertsVersion(header: string | null) {
  const version = Number(header);
  if (!header || !Number.isSafeInteger(version)) return;
  if (version <= useSiteAlertsVersionStore.getState().version) return;
  useSiteAlertsVersionStore.setState({ version });
}
