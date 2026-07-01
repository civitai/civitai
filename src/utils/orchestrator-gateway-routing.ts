// src/utils/orchestrator-gateway-routing.ts
//
// DARK feature-flag routing plumbing for the orchestrator-gateway spin-out
// (see claudedocs/plan-orchestrator-api-spinout-2026-06-30.md §4c in the
// datapacket-talos repo).
//
// This module is the single source of truth for the *client-side* decision of
// whether an `orchestrator.*` tRPC operation should be sent to the dedicated
// `civitai-orchestrator-gateway` service instead of the monolith.
//
// It is a PROVABLE NO-OP in its current state: `ORCHESTRATOR_GATEWAY_PROCEDURES`
// is EMPTY, so `shouldRouteToGateway()` returns `false` for every operation
// regardless of flag / env — 100% of traffic stays on the monolith. Enabling
// the gateway for a procedure is a two-dimensional gate (cohort flag AND
// procedure-in-allowlist), rolled out per the plan's phases.

/**
 * Procedure allowlist — the single source of truth for which `orchestrator.*`
 * procedures are actually implemented + ready on the gateway.
 *
 * EMPTY today = hard dark guarantee: nothing routes to the gateway even if the
 * flag resolves true for a mod and the env URL is set. This is what lets the
 * cohort flag (`orchestratorGatewayRouting`) go live to mods BEFORE all the
 * orchestrator procedures have been migrated — a mod in the cohort only routes
 * the procedures that appear here.
 *
 * Entries are the procedure path WITHOUT the `orchestrator.` prefix, e.g.
 * `'whatIfFromGraph'` (NOT `'orchestrator.whatIfFromGraph'`).
 *
 * Rollout (per plan §4 / §4c):
 *   - P1 adds `'whatIfFromGraph'` (read-only cost preview) once the gateway backs it.
 *   - P2 adds the generate/status procedures (submitWorkflow/generate, getWorkflow,
 *     queryWorkflows, cancelWorkflow, getWorkflowStatusUpdate, ...).
 *   - later phases add the remaining migrated procedures.
 *
 * ⚠️ GO-LIVE PRECONDITIONS — do NOT append a procedure here until, in order:
 *   1. CROSS-ORIGIN AUTH is wired. The gateway branch uses the same tRPC
 *      `httpLink`, whose `fetch` defaults to `credentials:'same-origin'`. Once
 *      the gateway is a different origin, allowlisted calls send NO cookies →
 *      they arrive UNAUTHENTICATED (and every call becomes a CORS preflight from
 *      the `x-client-*` headers). The enablement PR must add `credentials:'include'`
 *      on the gateway branch + gateway CORS (`Access-Control-Allow-Credentials`,
 *      echoed origin, allow `x-client-*`) + cookie `SameSite=None; Secure`.
 *   2. The gateway is DEPLOYED and actually backs the procedure, and
 *      `NEXT_PUBLIC_ORCHESTRATOR_GATEWAY_URL` is set, and the Flipt cohort is
 *      NARROW (start `[]`/off or `['mod']`) BEFORE the append — because adding one
 *      string here immediately routes that procedure for the ENTIRE cohort with
 *      no per-procedure percentage ramp (the only ramp is the Flipt cohort).
 *
 * NO MONOLITH FALLBACK: `splitLink` is a static route — an allowlisted op goes
 * ONLY to the gateway. If the gateway is down/5xx/TLS-fails the op FAILS (no
 * client retry-on-monolith). The kill-switch is Flipt-off OR emptying this array.
 */
export const ORCHESTRATOR_GATEWAY_PROCEDURES: string[] = [];

const ORCHESTRATOR_PREFIX = 'orchestrator.';

export type GatewayRoutingConfig = {
  /** The module-scope cached `orchestratorGatewayRouting` flag value (cohort gate). */
  enabled: boolean;
  /**
   * The gateway base URL (`NEXT_PUBLIC_ORCHESTRATOR_GATEWAY_URL`). When empty /
   * absent the split MUST fall back to the monolith — an empty URL means "no
   * gateway configured".
   */
  url: string | undefined;
  /** The procedure allowlist. Defaults to the module constant; overridable for tests. */
  allowlist?: string[];
};

/**
 * Pure routing predicate — extracted so the decision is unit-testable without a
 * live server or the `trpc.ts` link chain.
 *
 * Returns `true` (route to the gateway) ONLY when ALL of:
 *   1. the op path is an `orchestrator.*` path,
 *   2. the cohort flag is enabled (mounted from the SSR flag seed),
 *   3. the gateway URL env is a non-empty string, AND
 *   4. the procedure (path minus the `orchestrator.` prefix) is in the allowlist.
 *
 * Any miss → `false` → the operation stays on the monolith (safe default).
 * Because the allowlist ships EMPTY, condition (4) is ALWAYS false today, so
 * this ALWAYS returns `false` → zero behavior change.
 */
export function shouldRouteToGateway(path: string, config: GatewayRoutingConfig): boolean {
  const { enabled, url } = config;
  const allowlist = config.allowlist ?? ORCHESTRATOR_GATEWAY_PROCEDURES;

  if (!path.startsWith(ORCHESTRATOR_PREFIX)) return false;
  if (!enabled) return false;
  if (!url) return false;

  const procedure = path.slice(ORCHESTRATOR_PREFIX.length);
  return allowlist.includes(procedure);
}

/**
 * Normalize the raw `NEXT_PUBLIC_ORCHESTRATOR_GATEWAY_URL` into a clean gateway
 * base ORIGIN (no trailing slash). Returns `''` for empty/whitespace/absent —
 * `''` means "no gateway configured" → the split falls back to the monolith.
 *
 * Expects an origin only (e.g. `https://orchestrator-gateway.civitai.com`); a
 * value that already contains a path will be used verbatim (minus a trailing
 * slash) and is a config foot-gun — the caller appends the `/api/trpc` mount.
 */
export function resolveGatewayBase(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}
