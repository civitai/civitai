import client from 'prom-client';
import { PROM_PREFIX } from '@civitai/telemetry/client';

/**
 * APP DEV TUNNEL metrics (in-cluster Prometheus, per the design's Revision #3 —
 * Grafana stack, not ClickHouse/Axiom). Registered on the DEFAULT prom-client
 * registry (the request webpack graph) so `/api/metrics` scrapes them — the
 * tunnel lifecycle runs inside the tRPC request handlers, which live in that
 * graph (same as `civitai_app_http_errors_total`).
 *
 * Pinned on globalThis so an HMR re-eval / second request-graph eval reuse the
 * one instance instead of throwing prom-client's duplicate-registration error
 * (same trap documented for the http-error counter + instrumentationRegistry).
 *
 * Signals:
 *   - `civitai_app_dev_tunnels_active` (Gauge) — currently-live dev tunnels. inc
 *     on a successful mint, dec on teardown/reap. Per-pod; sum across pods for the
 *     fleet count. A non-negative floor is enforced so an over-decrement (double
 *     teardown) can't drive it below 0.
 *   - `civitai_app_dev_tunnel_mints_total` (Counter) — cumulative mints.
 *   - `civitai_app_dev_tunnel_teardowns_total{reason}` (Counter) — cumulative
 *     teardowns, labelled `stop` (explicit) | `reap-idle` | `reap-maxttl`.
 */

declare global {
  // eslint-disable-next-line no-var
  var __civitaiDevTunnelMetrics:
    | {
        active: client.Gauge<string>;
        mints: client.Counter<string>;
        teardowns: client.Counter<string>;
      }
    | undefined;
}

const metrics =
  globalThis.__civitaiDevTunnelMetrics ??
  (globalThis.__civitaiDevTunnelMetrics = {
    active: new client.Gauge({
      name: PROM_PREFIX + 'dev_tunnels_active',
      help: 'Currently-live App Blocks dev tunnels (per pod). inc on mint, dec on teardown/reap.',
    }),
    mints: new client.Counter({
      name: PROM_PREFIX + 'dev_tunnel_mints_total',
      help: 'Cumulative App Blocks dev-tunnel mints (startDevTunnel). Monotonic; use rate().',
    }),
    teardowns: new client.Counter({
      name: PROM_PREFIX + 'dev_tunnel_teardowns_total',
      help: 'Cumulative App Blocks dev-tunnel teardowns by reason (stop|reap-idle|reap-maxttl).',
      labelNames: ['reason'],
    }),
  });

export type DevTunnelTeardownReason = 'stop' | 'reap-idle' | 'reap-maxttl';

/** Record a successful mint: bump the active gauge + the mint counter. Never
 *  throws — a telemetry failure must not break the mint. */
export function recordDevTunnelMint(): void {
  try {
    metrics.active.inc();
    metrics.mints.inc();
  } catch {
    /* never throw from telemetry */
  }
}

/** Record a teardown: decrement the active gauge (floored at 0) + bump the
 *  teardown counter with the reason label. Never throws. */
export function recordDevTunnelTeardown(reason: DevTunnelTeardownReason): void {
  try {
    metrics.teardowns.inc({ reason });
    metrics.active.dec();
    // prom-client Gauge has no hard floor; guard against a double-teardown driving
    // the gauge negative by reading it back — cheap + per-teardown only.
    // (get() returns the sync snapshot for a plain Gauge with no labels.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const val = (metrics.active as any).hashMap?.['']?.value;
    if (typeof val === 'number' && val < 0) metrics.active.set(0);
  } catch {
    /* never throw from telemetry */
  }
}
