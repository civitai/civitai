import type { NextApiRequest, NextApiResponse } from 'next';
import { evaluateReadiness } from '~/server/readiness';

// Pod-local readiness probe: 200 when this pod is warm, its event loop is progressing and it is
// not shutting down; otherwise 503 with the reasons. No dependency checks and no network calls
// (see src/server/readiness.ts). /api/ready, /api/health and /api/live are unchanged.
//
// Not token-gated, unlike the other probes. It does no I/O, so it is no cheaper to abuse than a
// 404, and its body carries only booleans and reason codes. A token gate would also make every
// pod unready whenever the token is unset or mismatched, which is the fleet-wide coupling this
// probe exists to avoid.
export default async function readyz(_req: NextApiRequest, res: NextApiResponse) {
  const { ready, reasons, warmState, heartbeatAgeMs } = evaluateReadiness();
  res.setHeader('Cache-Control', 'no-store');
  if (ready) return res.status(200).json({ ready: true });
  return res.status(503).json({ ready: false, reasons, warmState, heartbeatAgeMs });
}
