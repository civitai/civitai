import type { NextApiRequest, NextApiResponse } from 'next';
import { isWarm } from '~/server/warmup';

// Pod-local readiness probe: should THIS pod get traffic instead of its siblings? 200 once the
// pod is warm, 503 before. No dependency checks and no I/O: a dependency outage hits every pod at
// once, so failing readiness on it can only pull the whole pool together. Dependency checks stay
// in /api/ready (the startup gate, so a build that cannot reach its dependencies never becomes
// Ready) and /api/health (diagnostics); both are unchanged, as is /api/live.
//
// isWarm() reads the warm state pinned on `globalThis` (see src/server/warmup.ts): the warmer runs
// from instrumentation, which is bundled separately from this route, so module-level state would
// never be seen here.
//
// Not token-gated, unlike the other probes. It does no I/O, so it is no cheaper to abuse than a
// 404, and its body is a boolean and a reason code. A token gate would also make every pod unready
// whenever the token is unset or mismatched, which is the fleet-wide coupling this probe avoids.
export default async function readyz(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (isWarm()) return res.status(200).json({ ready: true });
  return res.status(503).json({ ready: false, reason: 'cold' });
}
