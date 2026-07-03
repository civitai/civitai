import { logToAxiom } from '~/server/logging/client';
import { recordDevTunnelReaperRun } from '~/server/prom/dev-tunnel.metrics';
import { reapExpiredDevTunnels } from '~/server/services/blocks/dev-tunnel.service';
import { createJob } from './job';

/**
 * Server-authoritative reaper for orphaned App Blocks dev-tunnel routes.
 *
 * `startDevTunnel` renders an ephemeral Traefik IngressRoute + forwardAuth
 * Middleware for each `dev-<16hex>.<APPS_DOMAIN>` session. Those k8s objects carry
 * NO TTL of their own, so a CLI crash (or any missed `stopDevTunnel`) leaves the
 * route live until something sweeps it. The backing credential/session Redis keys
 * DO carry the 8h hard-TTL EX, so authz self-closes — but the k8s route lingers.
 * This job is that sweep: `reapExpiredDevTunnels()` LISTs the label-scoped routes
 * and deletes any whose session record has expired or vanished. It is NOT
 * CLI-dependent — that's the whole point (design T8).
 *
 * DARK-SAFE: with the `app-blocks-dev-tunnel` flag off (the current state) no
 * sessions exist, so every run is a single label-scoped LIST returning zero items
 * → an immediate no-op. It does one cheap k8s LIST per run regardless.
 *
 * FAIL-OPEN: a reaper failure (k8s API blip, TLS, transient list error) must NEVER
 * mark the runner failed or page — this is a best-effort janitor over an 8h
 * self-expiring resource. We catch, log structured, and return a benign result so
 * the run reports success and the next tick retries. (The core service already
 * best-efforts every teardown/delete; the uncaught vectors are the initial
 * `getDp1Target()` file read + the LIST `k8sFetch`, which we wrap here.)
 *
 * Pre-P3 gate item #3 (see datapacket-talos
 * claudedocs/app-blocks-dev-tunnel-design-2026-07-03.md §14). References
 * civitai #2920 (the P1 control plane that added the reaper primitive).
 *
 * ⚠️ RUNTIME REQUIREMENT — the reaper calls the k8s API via the pod's in-cluster
 * ServiceAccount (`getDp1Target` → `/var/run/secrets/.../token`). For those calls
 * to succeed the RUNNING pool must have BOTH:
 *   1. `NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`
 *      (else the HTTPS LIST/DELETE to the API server fails TLS verification), and
 *   2. the `civitai-web-apps-consumer` RBAC (get/list/watch/delete on
 *      traefik.io ingressroutes+middlewares in `civitai-apps`) — already bound to
 *      `civitai-dp-prod:default` (all pools).
 * The SSR / -api / -api-heavy pools set (1); the -jobs pool does NOT (as of
 * 2026-07-03). Schedule this job against a pool that has NODE_EXTRA_CA_CERTS, or
 * add it to deployment-jobs.yaml first — otherwise the reaper cannot delete
 * routes and logs a TLS error every run. Tracked as a pre-P3 infra blocker.
 */

/**
 * Cadence: every 5 minutes. The reaper only removes a route AFTER its session's
 * hard-TTL (8h) lapses in Redis, so cadence sets post-expiry sweep latency, not
 * detection — 5m is negligible against the 8h bound while keeping the per-run k8s
 * LIST churn low (matches the ingest-images / apply-tag-rules 5-minute cadence).
 * Tighten toward a 2-minute cadence only if orphan-route latency ever matters
 * (it does not at an 8h TTL).
 */
export const reapDevTunnelsJob = createJob('reap-dev-tunnels', '*/5 * * * *', async () => {
  try {
    const result = await reapExpiredDevTunnels();

    // A non-2xx LIST is a DISTINCT failure from a healthy empty sweep — the
    // reaper did nothing and could not reclaim routes. Log at error + count
    // `list_failed` so a persistent RBAC/ns/5xx break is queryable/alertable and
    // never a silent permanent no-op.
    if (!result.listOk) {
      recordDevTunnelReaperRun('list_failed');
      logToAxiom(
        {
          type: 'reap-dev-tunnels',
          level: 'error',
          message: 'dev-tunnel route LIST failed — reaper cannot reclaim routes',
          status: result.status,
        },
        'webhooks'
      ).catch(() => undefined);
      return result;
    }

    recordDevTunnelReaperRun('ok');
    // Only log when the sweep actually did something — a dark no-op stays silent.
    if (result.swept > 0 || result.reaped > 0 || result.skipped > 0) {
      logToAxiom(
        {
          type: 'reap-dev-tunnels',
          swept: result.swept,
          reaped: result.reaped,
          skipped: result.skipped,
        },
        'webhooks'
      ).catch(() => undefined);
    }
    return result;
  } catch (error) {
    // Never crash the runner on a reaper failure — log + count + continue.
    recordDevTunnelReaperRun('error');
    logToAxiom(
      {
        type: 'reap-dev-tunnels',
        level: 'error',
        message: (error as Error)?.message,
        stack: (error as Error)?.stack,
      },
      'webhooks'
    ).catch(() => undefined);
    return { swept: 0, reaped: 0, skipped: 0, listOk: false, error: true as const };
  }
});
