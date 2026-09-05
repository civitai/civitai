import type { NextApiRequest, NextApiResponse } from 'next';
import { isProd } from '~/env/other';
import { isWarm, getWarmState, getWarmDurationMs, didFailOpenTimeout } from '~/server/warmup';
import { runHealthChecks } from '~/pages/api/health';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getRandomInt } from '~/utils/number-helpers';

// Warmup-gated readiness probe.
//
// WHY: Next.js standalone lazy-`require()`s each route handler on its FIRST
// request. The dependency-only /api/health probe marks a pod Ready as soon as
// its DB/Redis/etc. are reachable — but at that instant every hot route is
// still COLD. The kubelet then sends real /api/v1/images, tRPC image.getInfinite,
// etc. to that pod; the first hit pays lazy-require + JIT compilation on the
// single event-loop thread → the loop pins → 504/502/499 (the cold-start
// cascade on every rollout). See the api-primary cascade history.
//
// This probe returns 200 only once BOTH are true:
//   1. isWarm()  — the in-process warmer (src/server/warmup.ts) has finished
//      self-requesting the hot routes (or fail-open-timed-out), so the JIT is
//      settled and no real user request pays the cold tax.
//   2. The same dependency checks /api/health runs are passing (reused via the
//      exported runHealthChecks() — one source of truth, identical disable
//      lists / per-check timeouts / overall deadline / prom metrics).
//
// This route is the STARTUP probe target; steady-state readiness probes /api/health.
// Liveness stays on /api/live. Same WebhookEndpoint `?token` gate as /api/health.
//
// 🔴 That split is load-bearing, and it is why this call passes `mode: 'startup'`.
// The DB write checks are fail-CLOSED here and fail-OPEN on /api/health:
//   - a pod that has NEVER reached the database must not enter the pool (here),
//   - a pod already serving that LOSES write must stay in the pool and degrade
//     (/api/health) — otherwise a stall on the shared write primary fails the
//     check on every replica in the same probe window and empties the load
//     balancer while every process is alive and idle.
// A startup probe stops running once it first succeeds, and a restarted pod runs
// it again, so fail-closed-at-boot is preserved for the lifetime of the pod.
//
// 🔴 If a deployment ever repoints its READINESS probe at this route, that
// fail-open protection is silently lost and a write-primary stall sheds the whole
// fleet again. Readiness belongs on /api/health. See STARTUP_ONLY_CRITICAL_CHECKS
// in health.ts.
export default WebhookEndpoint(async (_req: NextApiRequest, res: NextApiResponse) => {
  const podname = process.env.PODNAME ?? getRandomInt(100, 999);
  const warm = isWarm();
  // Surface warm observability in the body so an operator can tell a pod that
  // truly warmed (warmState='warmed-ok') from one that only fail-open-timed-out
  // (warmState='failopen-timeout', failOpenTimedOut=true) or one where the
  // warmer is disabled on this pool (warmState='disabled'). Mirrors the
  // civitai_warmup_state gauge.
  const warmState = getWarmState();
  const warmDurationMs = getWarmDurationMs();
  const failOpenTimedOut = didFailOpenTimeout();

  // Skip the (relatively expensive) dependency checks until the pod is warm —
  // a not-yet-warm pod is never Ready regardless of dependency state, and we
  // don't want startup-probe traffic adding DB/Redis load before the pod is
  // even serving. Reuse the client-disconnect abort wiring from health.ts.
  if (!warm) {
    return res.status(503).json({
      podname,
      version: process.env.version,
      ready: false,
      warm,
      warmState,
      warmDurationMs,
      failOpenTimedOut,
    });
  }

  const abortController = new AbortController();
  const { signal } = abortController;
  const onClose = () => {
    if (!isProd) console.log('Ready check request cancelled (client disconnected)');
    abortController.abort();
  };
  res.on('close', onClose);

  if (signal.aborted) {
    res.off('close', onClose);
    return;
  }

  // 'startup' keeps the DB write checks CRITICAL — fail closed. See the block
  // comment above; the default ('readiness') deliberately does not.
  const { healthy, results } = await runHealthChecks(signal, { mode: 'startup' });

  res.off('close', onClose);

  if (signal.aborted) {
    return;
  }

  const ready = warm && healthy;
  return res.status(ready ? 200 : 503).json({
    podname,
    version: process.env.version,
    ready,
    warm,
    warmState,
    warmDurationMs,
    failOpenTimedOut,
    deps: results,
  });
});
