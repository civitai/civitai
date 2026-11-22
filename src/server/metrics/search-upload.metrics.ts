import client, { type Counter, type Registry } from 'prom-client';

// Kept apart from semantic-search.metrics, which imports the tRPC server: /api/metrics loads this.
export const SEARCH_UPLOADS = 'search_upload_embed_total';
export const SEARCH_UPLOAD_RESULTS = ['prepared', 'refused', 'embedded'] as const;

/**
 * Seeds every result at 0, so the series exists before the first upload: an alert reads a real
 * series, and a counter born on its first inc would lose that count to increase().
 */
export function ensureRegisterSearchUploadMetrics(reg: Registry = client.register) {
  const existing = reg.getSingleMetric(SEARCH_UPLOADS) as Counter<string> | undefined;
  if (existing) return existing;
  const counter = new client.Counter({
    name: SEARCH_UPLOADS,
    help: 'Search-by-upload uploads by result: prepared, refused by the scan gate, or embedded',
    labelNames: ['result'],
    registers: [reg],
  });
  for (const result of SEARCH_UPLOAD_RESULTS) counter.inc({ result }, 0);
  return counter;
}

/** Search-by-upload uploads: prepared (scan submitted), refused (by the scan gate), embedded (searched). */
export function countSearchUpload(
  result: (typeof SEARCH_UPLOAD_RESULTS)[number],
  reg: Registry = client.register
) {
  ensureRegisterSearchUploadMetrics(reg).inc({ result });
}
