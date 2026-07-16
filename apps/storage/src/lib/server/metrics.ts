import { collectDefaultMetrics, Counter, Registry } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

// Reproduces the monolith's `b2_presign_issued_total`: a presigned upload URL was handed out for a B2
// backend. The actual PUT is browser-/streamer-direct (invisible pod-side), so issuance is the signal.
export const b2PresignIssued = new Counter({
  name: 'storage_b2_presign_issued_total',
  help: 'Presigned upload URLs issued for a B2 backend (browser/streamer-direct PUT is invisible pod-side).',
  labelNames: ['backend', 'bucket'],
  registers: [registry],
});
