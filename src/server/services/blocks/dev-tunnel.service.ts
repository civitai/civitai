import { env } from '~/env/server';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { newBlockInstanceId } from '~/server/utils/app-block-ids';
import {
  getDp1Target,
  k8sFetch,
  unwrap,
  waitForApplyJob,
} from '~/server/services/blocks/apps-pipeline.service';
import {
  fingerprintSshPublicKey,
  generateDevHostLabel,
  isValidDevHost,
  normalizeSshPublicKey,
} from '~/server/services/blocks/dev-tunnel-session';
import {
  recordDevTunnelMint,
  recordDevTunnelTeardown,
  type DevTunnelTeardownReason,
} from '~/server/prom/dev-tunnel.metrics';

/**
 * APP DEV TUNNEL — control-plane state + ephemeral Traefik route lifecycle.
 *
 * Generalizes the mod review sandbox (`apps-pipeline.service.ts` render +
 * `publish-request.service.ts` teardown) from "mod-bound, pending build" to
 * "author-bound, live sish tunnel". No DB migration: the credential/session state
 * is short-TTL and lives entirely in `sysRedis` (like the dev-token rate limiter +
 * the block Buzz cap), keyed under `system:blocks:dev-tunnel:*`.
 *
 * DARK: every caller is gated by `app-blocks-dev-tunnel` (base off) upstream, so
 * none of this runs in prod until P3 flips the flag. The public `ssh -R` exposure
 * (sish listener on the shared proxy) is a separate P3 infra change — the
 * BROWSER-facing Traefik route render here is inert without it.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Idle timeout (no browser activity) before the reaper tears a tunnel down. */
export const DEV_TUNNEL_IDLE_SECONDS = 30 * 60; // 30m (design §9)
/** Hard max lifetime — the credential Redis keys carry this as their EX, so an
 *  orphaned tunnel self-expires from the authz path even if the reaper never
 *  runs; the reaper additionally deletes the k8s route. */
export const DEV_TUNNEL_HARD_SECONDS = 8 * 60 * 60; // 8h (design §9)

/** Per-dev-session cumulative Buzz ceiling (backstop over the block-token
 *  DEV_BUZZ_BUDGET_CAP + the untouched per-user daily cap). Bounds a runaway
 *  local submit loop within ONE dev session. Conservative default. */
export const DEV_TUNNEL_SESSION_BUZZ_CAP = 5000;

/** A route whose backing session record is CONFIRMED-ABSENT is only reaped once
 *  its k8s object is older than this. Closes the create-before-persist race:
 *  `startDevTunnel` renders the route (`renderDevTunnelRoute`) BEFORE it writes
 *  the session key, so a sweep landing in that window sees the route + a null
 *  record and would otherwise tear down a just-created tunnel. The render+write
 *  window is sub-second in practice; a 2-minute guard is ample slack while still
 *  reclaiming a genuinely orphaned route within ~2 sweeps. */
export const DEV_TUNNEL_REAP_MIN_AGE_SECONDS = 2 * 60; // 2m

const SYS_PREFIX = REDIS_SYS_KEYS.BLOCKS.DEV_TUNNEL;
const credKey = (fingerprint: string) => `${SYS_PREFIX}:cred:${fingerprint}` as const;
const sessionKey = (sessionId: string) => `${SYS_PREFIX}:session:${sessionId}` as const;
const hostKey = (host: string) => `${SYS_PREFIX}:host:${host}` as const;
const userBlockKey = (userId: number, blockId: string) =>
  `${SYS_PREFIX}:user:${userId}:${blockId}` as const;
const spendKey = (sessionId: string) => `${SYS_PREFIX}:spend:${sessionId}` as const;

/** Label every rendered k8s object carries so the reaper + teardown can sweep by
 *  selector and never touch a live app (live apps carry no dev-tunnel label). */
const DEV_TUNNEL_LABEL = 'civitai.com/dev-tunnel';
const DEV_TUNNEL_SESSION_LABEL = 'civitai.com/dev-tunnel-session';

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

export type DevTunnelSessionRecord = {
  sessionId: string;
  userId: number;
  blockId: string;
  host: string;
  fingerprint: string;
  createdAt: number; // unix seconds
  hardExpiresAt: number; // unix seconds
  spendCapBuzz: number;
  /** Last browser-activity marker (unix seconds), refreshed by the forwardAuth
   *  gate on each successful ENTRY-document hit (F3). The reaper reaps a session
   *  idle past DEV_TUNNEL_IDLE_SECONDS. ABSENT on a never-visited tunnel → the
   *  reaper falls back to `createdAt` so a CLI that dies before the browser ever
   *  loads still idle-reaps. */
  lastActivityAt?: number;
};

/** The subset of the credential the sish authz callback needs. Stored separately
 *  keyed by pubkey fingerprint (the callback's lookup index). */
type DevTunnelCredentialRecord = {
  sessionId: string;
  userId: number;
  blockId: string;
  host: string;
  /** Full normalized SSH public key — the authz decision constant-time compares
   *  this against the presented `auth_key`. The fingerprint is only the index. */
  sshPublicKey: string;
  hardExpiresAt: number;
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** All dev-tunnel sub-keys share this template — a subtype of the branded
 *  sysRedis key union, so `sysRedis.get(key)` type-checks. */
type DevTunnelKey = `${typeof SYS_PREFIX}:${string}`;

async function readJson<T>(key: DevTunnelKey): Promise<T | null> {
  try {
    const raw = await withSysReadDeadline(sysRedis.get(key));
    if (!raw || typeof raw !== 'string') return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// NOTE (rebase resolution): the reaper's `ReapResult` contract + the reap
// session-read / apiserver-clock / idle helpers are defined together in the
// Reaper section below (this PR's superset version — idle-reap + ingressroute∪
// middleware union). #2928's parallel helpers here were dropped to keep a SINGLE
// canonical copy; the shared `readJson` above stays.

// ---------------------------------------------------------------------------
// Manifest builders (PURE — exported for shape tests)
// ---------------------------------------------------------------------------

export type DevTunnelManifestOpts = {
  host: string;
  sessionId: string;
  namespace: string;
  /** in-cluster forwardAuth address (the dev-tunnel-gate endpoint). */
  forwardAuthUrl: string;
  /** sish HTTP backend the reverse tunnel is bound behind. */
  sishBackend: string;
  /** Traefik LB IP the ephemeral `dev-<hex>.<APPS_DOMAIN>` DNS record targets.
   *  When set, the IngressRoute carries external-dns annotations so external-dns
   *  (source=traefik-proxy, domain civit.ai) creates the CF-proxied record — WITHOUT
   *  it the host is NXDOMAIN and the browser can't load the tunnel. Sourced from env
   *  (APPS_DEV_TUNNEL_INGRESS_TARGET, set per-environment) rather than hardcoded, so
   *  the origin IP is not committed here; unset ⇒ annotations omitted (no record). */
  ingressTarget?: string;
};

/** Build the ephemeral forwardAuth Middleware for a dev-tunnel host. The
 *  Middleware points Traefik at the dev-tunnel-gate endpoint, which requires the
 *  parent-minted author-bound entry token on the ENTRY document (T3). */
export function buildDevTunnelMiddleware(opts: DevTunnelManifestOpts) {
  // Name is a k8s RESOURCE name → must be DNS-1123 (no uppercase/`_` from the raw
  // bki_<ULID> sessionId). Labels below keep the raw sessionId (label values allow
  // them, and the reaper matches on the label).
  const name = `dev-tunnel-gate-${sessionResourceSuffix(opts.sessionId)}`;
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'Middleware',
    metadata: {
      name,
      namespace: opts.namespace,
      labels: {
        [DEV_TUNNEL_LABEL]: 'true',
        [DEV_TUNNEL_SESSION_LABEL]: opts.sessionId,
      },
    },
    spec: {
      forwardAuth: {
        address: opts.forwardAuthUrl,
        // Forward the headers the gate reasons over. Traefik always forwards
        // X-Forwarded-* + the ENTRY request's own Sec-Fetch-Dest.
        authResponseHeaders: ['X-Dev-User-Id'],
      },
    },
  } as const;
}

/** Build the ephemeral IngressRoute for a dev-tunnel host. Matches the exact
 *  `dev-<16hex>.<APPS_DOMAIN>` host (server-derived), gates with the forwardAuth
 *  Middleware, and routes to the sish HTTP backend. TLS via the existing
 *  `*.civit.ai` wildcard cert (default TLS store — no per-host cert). */
export function buildDevTunnelIngressRoute(opts: DevTunnelManifestOpts) {
  // k8s RESOURCE names → DNS-1123 (see sessionResourceSuffix). middlewareName MUST
  // derive identically to buildDevTunnelMiddleware's name so the route references the
  // Middleware that actually gets created. Labels keep the raw sessionId.
  const suffix = sessionResourceSuffix(opts.sessionId);
  const name = `dev-tunnel-${suffix}`;
  const middlewareName = `dev-tunnel-gate-${suffix}`;
  // Split the backend into host:port for the Traefik ExternalName-style service
  // reference is not needed — Traefik IngressRoute services reference an in-ns
  // Service by name+port. The sish backend is a Service in the sish namespace, so
  // we use a Traefik `services[].name` + `namespace`. Parse host/port defensively.
  const backend = parseBackend(opts.sishBackend);
  // external-dns (source=traefik-proxy, domain civit.ai) creates the CF-proxied DNS
  // record for the ephemeral host from THESE annotations — mirroring the per-app-block
  // routes (`<slug>.civit.ai`). Without them the host is NXDOMAIN and the browser can't
  // load the tunnel. Gated on ingressTarget (the Traefik LB IP, from env) so the origin
  // IP is not committed here; unset ⇒ no annotations ⇒ no record.
  // ⚠️ NOT auto-cleaned: the civit.ai external-dns is `policy: upsert-only`, so deleting
  // the route does NOT remove the record (orphan-DNS GC is a tracked follow-up).
  const externalDnsAnnotations = opts.ingressTarget
    ? {
        'external-dns.alpha.kubernetes.io/hostname': opts.host,
        'external-dns.alpha.kubernetes.io/target': opts.ingressTarget,
        'external-dns.alpha.kubernetes.io/cloudflare-proxied': 'true',
      }
    : undefined;
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: {
      name,
      namespace: opts.namespace,
      labels: {
        [DEV_TUNNEL_LABEL]: 'true',
        [DEV_TUNNEL_SESSION_LABEL]: opts.sessionId,
      },
      ...(externalDnsAnnotations ? { annotations: externalDnsAnnotations } : {}),
    },
    spec: {
      // Cloudflare pulls the civit.ai origin over HTTP :80 (Flexible SSL); a
      // websecure-only route is invisible to CF's port-80 origin request → 404.
      // Mirror the app-block IngressRoutes (web+websecure). The forwardAuth gate
      // middleware below is per-route, so naked-URL protection holds on both ports.
      // Traefik still serves TLS on `websecure` via its default cert (no `tls` key
      // needed — matches the proven-working app-block route shape).
      entryPoints: ['web', 'websecure'],
      routes: [
        {
          match: `Host(\`${opts.host}\`)`,
          kind: 'Rule',
          middlewares: [{ name: middlewareName, namespace: opts.namespace }],
          services: [
            {
              name: backend.service,
              namespace: backend.namespace,
              port: backend.port,
            },
          ],
        },
      ],
    },
  } as const;
}

/** Parse `http://sish-http.apps-dev-tunnel.svc.cluster.local:8080` (or a bare
 *  `service.namespace:port`) into the Traefik service reference parts. Defensive
 *  defaults keep a shape valid even for a terse backend string. */
function parseBackend(raw: string): { service: string; namespace: string; port: number } {
  const stripped = raw.replace(/^https?:\/\//, '');
  const [hostPart, portPart] = stripped.split(':');
  const port = Number(portPart ?? '8080') || 8080;
  const segs = hostPart.split('.');
  const service = segs[0] || 'sish-http';
  const namespace = segs[1] || 'apps-dev-tunnel';
  return { service, namespace, port };
}

function forwardAuthUrl(): string {
  // In-cluster address of the dev-tunnel-gate endpoint. Defaults to the civitai-web
  // internal Service; overridable via env for the real cluster wiring (P3).
  return (
    env.APPS_DEV_TUNNEL_FORWARDAUTH_URL ??
    'http://civitai-web.civitai.svc.cluster.local/api/internal/dev-tunnel-gate'
  );
}

function sishBackend(): string {
  return env.APPS_DEV_TUNNEL_SISH_BACKEND;
}

function manifestOpts(host: string, sessionId: string): DevTunnelManifestOpts {
  return {
    host,
    sessionId,
    namespace: env.APPS_DEV_TUNNEL_ROUTE_NAMESPACE,
    forwardAuthUrl: forwardAuthUrl(),
    sishBackend: sishBackend(),
    ingressTarget: env.APPS_DEV_TUNNEL_INGRESS_TARGET,
  };
}

// ---------------------------------------------------------------------------
// k8s apply / delete (thin, reuses apps-pipeline helpers)
// ---------------------------------------------------------------------------

/** DNS-1123-safe suffix from an opaque sessionId for use in k8s RESOURCE NAMES.
 *  `sessionId` is `bki_<ulid>` — Crockford base32 (UPPERCASE) with a `_` separator;
 *  k8s resource names forbid uppercase and `_` (RFC 1123 subdomain), so we lowercase
 *  + replace any non-`[a-z0-9-]` char and bound the length. Label VALUES, by
 *  contrast, DO permit uppercase/`_`, so labels keep the RAW sessionId (the reaper
 *  deletes routes by label selector, not by name). Used by the Job, Middleware, and
 *  IngressRoute names so they all agree. */
export function sessionResourceSuffix(sessionId: string): string {
  return sessionId.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40);
}

/** DNS-1123 Job name for a session's route-apply Job. */
export function devTunnelApplyJobName(sessionId: string): string {
  return `dev-tunnel-apply-${sessionResourceSuffix(sessionId)}`;
}

/**
 * The bash script the route-apply Job runs. `kubectl apply`s the (fully
 * server-rendered) Middleware then IngressRoute from env-injected JSON — no
 * template ConfigMap, no envsubst. `kubectl apply` is create-or-update, so a
 * re-render of the same session is naturally idempotent. Pure + exported so the
 * shape stays locked in a unit test.
 */
export function buildDevTunnelApplyScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "\${MIDDLEWARE_JSON}" | kubectl apply -f -
printf '%s' "\${INGRESSROUTE_JSON}" | kubectl apply -f -
echo "dev-tunnel route applied"
`;
}

/**
 * Build the route-apply Job. CRITICAL (F1): runs as the narrowly-scoped
 * `apps-applier` ServiceAccount — the SAME SA the review sandbox renders through
 * (`triggerApplyReview`) — which HAS `create`/`patch` on traefik.io CRDs in
 * `civitai-apps` (review sandbox) AND, via the dev-tunnel-route-applier RoleBinding,
 * in `apps-dev-tunnel` (this feature's route namespace — same ns as the sish backend,
 * so Traefik accepts the service ref). Scoped to those two CRDs in those two
 * namespaces; it cannot touch anything else. The web-pod SA
 * (`civitai-web-apps-consumer`) grants only get/list/watch/delete on those CRDs,
 * so rendering the route DIRECTLY from the web pod 403'd (the untracked P3
 * functional blocker); it would ALSO be a security regression to broaden the
 * live web-pod SA to `create` (any civitai-web SSRF/RCE → arbitrary-IngressRoute
 * creation → hijack of live app hosts). The Job is the isolation boundary. The
 * web-pod SA (civitai-dp-prod `default`) CREATES the Job + LISTs/DELETEs routes on
 * teardown (deleteDevTunnelRoute / reapExpiredDevTunnels). Its RoleBinding in
 * apps-dev-tunnel currently grants the full CRD verb set (tracked hardening: narrow it
 * to read+delete); but allowCrossNamespace=false confines any IngressRoute it could
 * create there to apps-dev-tunnel services (sish only) — no live-app-host hijack.
 *
 * Pure + exported for a shape test.
 */
export function buildDevTunnelApplyJob(opts: {
  ns: string;
  jobName: string;
  sessionId: string;
  middleware: unknown;
  ingressRoute: unknown;
}) {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: opts.jobName,
      namespace: opts.ns,
      labels: {
        app: opts.jobName,
        'civitai.com/role': 'apply-job',
        [DEV_TUNNEL_LABEL]: 'true',
        [DEV_TUNNEL_SESSION_LABEL]: opts.sessionId,
      },
    },
    spec: {
      backoffLimit: 2,
      // F1-1: a hung apply pod (restartPolicy:Never, stuck image pull / API
      // throttle) would never become terminal → never TTL-GC'd, and since each
      // re-mint uses a fresh sessionId→jobName the pre-delete-by-name can't reclaim
      // it → hung Jobs would accumulate. activeDeadlineSeconds guarantees the Job
      // becomes terminal (DeadlineExceeded) so ttlSecondsAfterFinished GCs it.
      // MUST be >= renderDevTunnelRoute's waitForApplyJob timeout (180s) so a
      // slow-but-succeeding cold image pull isn't killed before the wait observes
      // success (which would orphan a route the pod may have already applied).
      activeDeadlineSeconds: 200,
      // Short TTL after the Job reaches a terminal state (Complete/DeadlineExceeded).
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: {
          labels: {
            'civitai.com/role': 'apply-job',
            [DEV_TUNNEL_LABEL]: 'true',
            [DEV_TUNNEL_SESSION_LABEL]: opts.sessionId,
          },
        },
        spec: {
          // The narrowly-scoped apply SA (has create on traefik CRDs; ns-locked).
          serviceAccountName: 'apps-applier',
          restartPolicy: 'Never',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'apply',
              image: 'alpine/k8s:1.34.0',
              imagePullPolicy: 'IfNotPresent',
              env: [
                { name: 'MIDDLEWARE_JSON', value: JSON.stringify(opts.middleware) },
                { name: 'INGRESSROUTE_JSON', value: JSON.stringify(opts.ingressRoute) },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
              command: ['/bin/bash', '-c'],
              args: [buildDevTunnelApplyScript()],
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '250m', memory: '128Mi' },
              },
            },
          ],
          volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '8Mi' } }],
        },
      },
    },
  };
}

/**
 * Render the ephemeral Traefik IngressRoute + forwardAuth Middleware for a
 * dev-tunnel host by dispatching a render-and-apply Job that runs as the scoped
 * `apps-applier` SA — the SAME mechanism the review sandbox uses (F1). The
 * web-pod SA only creates the Job + waits for it; the Job (apps-applier) is what
 * `kubectl apply`s the CRDs. Awaits the Job to Succeeded so `startDevTunnel` can
 * keep its "render FIRST → persist state only on success" contract (a failed
 * render throws → nothing is persisted → no orphan).
 */
export async function renderDevTunnelRoute(host: string, sessionId: string): Promise<void> {
  const target = await getDp1Target();
  const ns = env.APPS_KUBE_NAMESPACE;
  const opts = manifestOpts(host, sessionId);
  const mw = buildDevTunnelMiddleware(opts);
  const ir = buildDevTunnelIngressRoute(opts);
  const jobName = devTunnelApplyJobName(sessionId);
  const job = buildDevTunnelApplyJob({ ns, jobName, sessionId, middleware: mw, ingressRoute: ir });

  // Re-rendering the same session must restart the apply — delete a same-name Job
  // first (404 is fine). This is a Job DELETE, which the web-pod SA CAN do.
  await k8sFetch(target, `/apis/batch/v1/namespaces/${ns}/jobs/${jobName}?propagationPolicy=Background`, {
    method: 'DELETE',
  }).then(async (r) => {
    if (!r.ok && r.status !== 404) {
      const body = await r.text().catch(() => '');
      throw new Error(`dev-tunnel pre-delete apply Job ${r.status}: ${body.slice(0, 200)}`);
    }
  });

  const res = await k8sFetch(target, `/apis/batch/v1/namespaces/${ns}/jobs`, {
    method: 'POST',
    body: JSON.stringify(job),
  });
  await unwrap<{ metadata: { name: string } }>(res);

  // F1-3: 180s tolerates a cold `alpine/k8s` image pull (the review-sandbox
  // reference waits ~6min). Kept < the Job's activeDeadlineSeconds (200s) so a
  // slow-but-succeeding pull is observed as success here before the Job's own
  // deadline fires — see buildDevTunnelApplyJob for the reconciliation.
  const outcome = await waitForApplyJob(jobName, { timeoutMs: 180_000, pollMs: 2_000 });
  if (outcome !== 'succeeded') {
    throw new Error(`dev-tunnel route apply Job ${outcome} (session ${sessionId})`);
  }
}

// ---------------------------------------------------------------------------
// Cloudflare orphan-DNS cleanup (best-effort — external-dns is upsert-only)
// ---------------------------------------------------------------------------
//
// external-dns runs `policy: upsert-only` on the civit.ai zone, so deleting a
// dev-tunnel IngressRoute leaves its `dev-<hex>.civit.ai` A record AND the
// external-dns ownership TXT registry records behind — with no GC they accumulate
// forever (a CF zone record-cap risk at scale). This best-effort deleter removes
// them via the Cloudflare API when a tunnel is torn down or reaped. It is OPT-IN
// (unset APPS_DEV_TUNNEL_CF_API_TOKEN ⇒ no-op, records linger as before) and NEVER
// throws — it must not break teardown/reap.

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
/** Per-call HTTP timeout — the CF API is best-effort, keep it snappy. */
const CF_CALL_TIMEOUT_MS = 5_000;
/** External-dns annotation carrying the ephemeral dev host on the IngressRoute. */
const EXTERNAL_DNS_HOSTNAME_ANNOTATION = 'external-dns.alpha.kubernetes.io/hostname';
/** SAFETY guard: only ever act on a well-formed ephemeral dev host
 *  `dev-<16hex>.<...>` — refuse anything else so a malformed/foreign host can
 *  never delete an unrelated CF record. Extends DEV_HOST_LABEL_REGEX (the label)
 *  to the full-host prefix; the queried names are `<host>` and `a-<host>`, both of
 *  which then necessarily start with `dev-`/`a-dev-`. */
const DEV_HOST_PREFIX_REGEX = /^dev-[a-f0-9]{16}\./;

/** The CF v4 response envelope. */
type CfEnvelope<T> = { success: boolean; result: T; errors?: unknown };

/** In-process cache of the resolved civit.ai zone id (only used on the lookup
 *  path — the env-provided id bypasses it). */
let cfZoneIdCache: string | null = null;

/** TEST-ONLY: reset the in-process zone-id cache between cases. */
export function __resetDevTunnelDnsCacheForTest(): void {
  cfZoneIdCache = null;
}

/** The registrable (last-two-label) domain of a host — the CF zone name. e.g.
 *  `dev-abc.civit.ai` → `civit.ai`. */
function registrableDomain(host: string): string {
  return host.split('.').slice(-2).join('.');
}

async function cfFetch(
  path: string,
  token: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<Response> {
  return fetchImpl(`${CF_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(CF_CALL_TIMEOUT_MS),
  });
}

/** Resolve the CF zone id: prefer the env id; else look it up by name (once,
 *  cached). Returns null when it can't be resolved (the deleter then no-ops). */
async function resolveCfZoneId(
  domain: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<string | null> {
  if (env.APPS_DEV_TUNNEL_CF_ZONE_ID) return env.APPS_DEV_TUNNEL_CF_ZONE_ID;
  if (cfZoneIdCache) return cfZoneIdCache;
  const res = await cfFetch(
    `/zones?name=${encodeURIComponent(domain)}`,
    token,
    { method: 'GET' },
    fetchImpl
  );
  if (!res.ok) return null;
  const body = (await res.json()) as CfEnvelope<Array<{ id?: string }>>;
  const id = body?.success ? body.result?.[0]?.id : undefined;
  if (typeof id === 'string' && id) {
    cfZoneIdCache = id;
    return id;
  }
  return null;
}

/** List the CF record ids (any type) whose name is exactly `name`. */
async function listCfRecordIds(
  zoneId: string,
  name: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<string[]> {
  const res = await cfFetch(
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
    token,
    { method: 'GET' },
    fetchImpl
  );
  if (!res.ok) return [];
  const body = (await res.json()) as CfEnvelope<Array<{ id?: string }>>;
  if (!body?.success || !Array.isArray(body.result)) return [];
  return body.result
    .map((r) => r?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Best-effort deletion of the orphan Cloudflare DNS records for a dev-tunnel
 * host. Removes EVERY record named `<host>` OR `a-<host>` (external-dns's A record
 * PLUS its TXT-registry ownership records — whose name is either the bare host or
 * the type-prefixed `a-<host>` form depending on external-dns version — so
 * deleting both names covers the A record + both TXT formats). No-op when
 * unconfigured; refuses any host that isn't a well-formed `dev-<16hex>.…`; NEVER
 * throws. `fetchImpl` is injected for testing (defaults to global fetch).
 */
export async function deleteDevTunnelDns(
  host: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  try {
    const token = env.APPS_DEV_TUNNEL_CF_API_TOKEN;
    if (!token) return; // feature off — records linger as before
    if (!host || typeof host !== 'string' || !DEV_HOST_PREFIX_REGEX.test(host)) {
      // SAFETY: never touch a name that isn't a well-formed ephemeral dev host.
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({ event: 'app-blocks.dev-tunnel.dns-gc.refused', host }));
      return;
    }
    const zoneId = await resolveCfZoneId(registrableDomain(host), token, fetchImpl);
    if (!zoneId) return;
    // The A record and BOTH external-dns TXT-registry name forms.
    const ids = new Set<string>();
    for (const name of [host, `a-${host}`]) {
      for (const id of await listCfRecordIds(zoneId, name, token, fetchImpl)) ids.add(id);
    }
    for (const id of ids) {
      await cfFetch(`/zones/${zoneId}/dns_records/${id}`, token, { method: 'DELETE' }, fetchImpl)
        .then((r) => {
          if (!r.ok) {
            // eslint-disable-next-line no-console
            console.warn(
              JSON.stringify({
                event: 'app-blocks.dev-tunnel.dns-gc.delete-failed',
                host,
                id,
                status: r.status,
              })
            );
          }
        })
        .catch(() => {
          /* best-effort per-record delete */
        });
    }
  } catch (e) {
    // Best-effort — a CF hiccup must NEVER break teardown/reap.
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        event: 'app-blocks.dev-tunnel.dns-gc.error',
        host,
        error: (e as Error)?.message,
      })
    );
  }
}

/** Delete the ephemeral Traefik route for ONE session by label selector. Scoped
 *  to `civitai.com/dev-tunnel-session=<id>` so it can only ever touch THAT
 *  session's objects, never a live app. Best-effort + idempotent. Also best-effort
 *  GCs the orphan CF DNS record for the route host (external-dns is upsert-only, so
 *  it never removes the `dev-<hex>.civit.ai` record itself) — the host is read from
 *  the IngressRoute's external-dns hostname annotation, so cleanup runs iff a record
 *  was actually created (annotation present ⟺ ingressTarget was set at mint). */
export async function deleteDevTunnelRoute(sessionId: string): Promise<void> {
  const target = await getDp1Target();
  const ns = env.APPS_DEV_TUNNEL_ROUTE_NAMESPACE;
  const selector = encodeURIComponent(`${DEV_TUNNEL_SESSION_LABEL}=${sessionId}`);
  let devHost: string | undefined;
  const kinds: Array<{ listPath: string; itemPath: (n: string) => string }> = [
    {
      listPath: `/apis/traefik.io/v1alpha1/namespaces/${ns}/ingressroutes?labelSelector=${selector}`,
      itemPath: (n) => `/apis/traefik.io/v1alpha1/namespaces/${ns}/ingressroutes/${n}`,
    },
    {
      listPath: `/apis/traefik.io/v1alpha1/namespaces/${ns}/middlewares?labelSelector=${selector}`,
      itemPath: (n) => `/apis/traefik.io/v1alpha1/namespaces/${ns}/middlewares/${n}`,
    },
  ];
  for (const k of kinds) {
    try {
      const listRes = await k8sFetch(target, k.listPath, { method: 'GET' });
      if (!listRes.ok) continue;
      const list = await unwrap<{
        items?: Array<{ metadata?: { name?: string; annotations?: Record<string, string> } }>;
      }>(listRes);
      const items = list?.items ?? [];
      // Capture the ephemeral DNS host from the IngressRoute annotation (only the
      // IngressRoute carries it) for the post-delete CF GC.
      for (const it of items) {
        const h = it?.metadata?.annotations?.[EXTERNAL_DNS_HOSTNAME_ANNOTATION];
        if (!devHost && typeof h === 'string' && h) devHost = h;
      }
      const names = items
        .map((it) => it?.metadata?.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0);
      for (const name of names) {
        await k8sFetch(target, `${k.itemPath(name)}?propagationPolicy=Background`, {
          method: 'DELETE',
        }).catch(() => {
          /* best-effort */
        });
      }
    } catch {
      /* a single kind failing must not abort the sweep */
    }
  }
  // Best-effort orphan-DNS GC AFTER the k8s objects are gone — never blocks/fails
  // teardown. No annotation ⇒ no record was created ⇒ nothing to clean.
  if (devHost) await deleteDevTunnelDns(devHost).catch(() => {});
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type StartDevTunnelParams = {
  userId: number;
  blockId: string;
  /** The CLI's ephemeral SSH public key (raw OpenSSH line). */
  sshPublicKey: string;
};

export type StartDevTunnelResult = {
  sessionId: string;
  host: string;
  /** The URL the dev opens in their own browser. */
  url: string;
  expiresAt: number;
  spendCapBuzz: number;
  /** The sish server's SSH HOST public key (non-secret OpenSSH line) so the CLI
   *  can PIN it on the `ssh -R` hop (R1). Empty string when unconfigured — the
   *  CLI MUST fail closed (refuse to connect) rather than ignore the host key. */
  sshHostPublicKey: string;
};

/**
 * Mint a dev-tunnel credential + host, render the ephemeral Traefik route, and
 * persist the session state in Redis. Enforces ONE active tunnel per (user,
 * blockId): a prior session for the same pair is torn down first (route + keys).
 *
 * The caller (the tRPC procedure) has ALREADY gated author + ownership + all
 * flags — this function trusts `userId`/`blockId` as authorized and never
 * re-derives authz from client input.
 */
export async function startDevTunnel(params: StartDevTunnelParams): Promise<StartDevTunnelResult> {
  const normalizedKey = normalizeSshPublicKey(params.sshPublicKey);
  if (!normalizedKey) throw new Error('invalid SSH public key');
  const fingerprint = fingerprintSshPublicKey(normalizedKey);
  if (!fingerprint) throw new Error('invalid SSH public key');

  // Tear down any existing tunnel for this (user, block) so a re-run doesn't
  // orphan a route/credential.
  await stopDevTunnelForUserBlock(params.userId, params.blockId).catch(() => {});

  const sessionId = newBlockInstanceId(); // `bki_<ulid>` — opaque, unique
  const host = `${generateDevHostLabel()}.${env.APPS_DOMAIN}`;
  const created = nowSec();
  const hardExpiresAt = created + DEV_TUNNEL_HARD_SECONDS;

  const session: DevTunnelSessionRecord = {
    sessionId,
    userId: params.userId,
    blockId: params.blockId,
    host,
    fingerprint,
    createdAt: created,
    hardExpiresAt,
    spendCapBuzz: DEV_TUNNEL_SESSION_BUZZ_CAP,
    // Seed the idle marker at mint so a never-visited tunnel still idle-reaps
    // (createdAt fallback in the reaper covers an absent field too).
    lastActivityAt: created,
  };
  const credential: DevTunnelCredentialRecord = {
    sessionId,
    userId: params.userId,
    blockId: params.blockId,
    host,
    sshPublicKey: normalizedKey,
    hardExpiresAt,
  };

  // Render the Traefik route FIRST — if it fails we never persist state, so a
  // failed mint leaves nothing behind.
  await renderDevTunnelRoute(host, sessionId);

  // Persist the index + records, all with the hard-TTL EX so they self-expire.
  await Promise.all([
    sysRedis.set(credKey(fingerprint), JSON.stringify(credential), { EX: DEV_TUNNEL_HARD_SECONDS }),
    sysRedis.set(sessionKey(sessionId), JSON.stringify(session), { EX: DEV_TUNNEL_HARD_SECONDS }),
    sysRedis.set(hostKey(host), sessionId, { EX: DEV_TUNNEL_HARD_SECONDS }),
    sysRedis.set(userBlockKey(params.userId, params.blockId), sessionId, {
      EX: DEV_TUNNEL_HARD_SECONDS,
    }),
  ]);

  recordDevTunnelMint();
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: 'app-blocks.dev-tunnel.start',
      sessionId,
      userId: params.userId,
      blockId: params.blockId,
      host,
      expiresAt: hardExpiresAt,
    })
  );

  return {
    sessionId,
    host,
    url: `${(env.NEXTAUTH_URL ?? 'https://civitai.com').replace(/\/$/, '')}/apps/dev/${params.blockId}`,
    expiresAt: hardExpiresAt,
    spendCapBuzz: DEV_TUNNEL_SESSION_BUZZ_CAP,
    // R1: hand the CLI the sish host pubkey to pin. Empty when unconfigured (the
    // CLI fails closed). Non-secret, so it rides the mint response directly.
    sshHostPublicKey: env.APPS_DEV_TUNNEL_SSH_HOST_PUBKEY ?? '',
  };
}

/** Delete all state + the route for a session (used by stop + reap). Best-effort;
 *  never throws. `reason` labels the teardown metric. */
async function teardownSession(
  session: DevTunnelSessionRecord,
  reason: DevTunnelTeardownReason
): Promise<void> {
  await deleteDevTunnelRoute(session.sessionId).catch(() => {});
  await Promise.all([
    sysRedis.del(credKey(session.fingerprint)).catch(() => {}),
    sysRedis.del(sessionKey(session.sessionId)).catch(() => {}),
    sysRedis.del(hostKey(session.host)).catch(() => {}),
    sysRedis.del(userBlockKey(session.userId, session.blockId)).catch(() => {}),
    sysRedis.del(spendKey(session.sessionId)).catch(() => {}),
  ]);
  recordDevTunnelTeardown(reason);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: 'app-blocks.dev-tunnel.stop',
      sessionId: session.sessionId,
      userId: session.userId,
      blockId: session.blockId,
      host: session.host,
      reason,
    })
  );
}

/** Stop a dev tunnel by sessionId, but ONLY if it belongs to `userId` (defence:
 *  a caller can never tear down another author's tunnel). Returns true if a
 *  session was found + torn down. */
export async function stopDevTunnel(userId: number, sessionId: string): Promise<boolean> {
  const session = await readJson<DevTunnelSessionRecord>(sessionKey(sessionId));
  if (!session || session.userId !== userId) return false;
  await teardownSession(session, 'stop');
  return true;
}

/** Stop whatever active tunnel exists for a (user, block) pair (used by
 *  startDevTunnel to reclaim the single active slot, and by stopDevTunnel by
 *  blockId). */
export async function stopDevTunnelForUserBlock(userId: number, blockId: string): Promise<boolean> {
  // The user-block index stores a BARE sessionId string (not JSON).
  const sessionId = await withSysReadDeadline(
    sysRedis.get(userBlockKey(userId, blockId))
  ).catch(() => null);
  if (!sessionId || typeof sessionId !== 'string') return false;
  return stopDevTunnel(userId, sessionId);
}

/** Resolve the active dev-tunnel session for a (user, block), for the SSR route +
 *  the status procedure. Returns null when none is active. */
export async function getActiveDevTunnel(
  userId: number,
  blockId: string
): Promise<DevTunnelSessionRecord | null> {
  const sessionId = await withSysReadDeadline(
    sysRedis.get(userBlockKey(userId, blockId))
  ).catch(() => null);
  if (!sessionId || typeof sessionId !== 'string') return null;
  const session = await readJson<DevTunnelSessionRecord>(sessionKey(sessionId));
  // Cross-check ownership + freshness (fail-closed on a stale/foreign index).
  if (!session || session.userId !== userId || session.blockId !== blockId) return null;
  if (session.host && !isValidDevHost(session.host, env.APPS_DOMAIN)) return null;
  if (session.hardExpiresAt <= nowSec()) return null;
  return session;
}

/**
 * Refresh a session's idle marker on browser activity (F3). Called by the
 * forwardAuth gate on each successful ENTRY-document hit. Resolves the session
 * from the dev host, stamps `lastActivityAt = now`, and re-persists the session
 * key WITHOUT extending the hard-TTL: the EX is recomputed as the REMAINING time
 * until `hardExpiresAt`, so activity can never push a tunnel past its 8h hard
 * cap. Best-effort — a Redis hiccup here must never fail the gate decision (the
 * auth response is already sent), so it swallows all errors and is a no-op past
 * the hard expiry (the reaper then collects the route).
 */
export async function touchDevTunnelActivity(host: string): Promise<void> {
  if (!host || typeof host !== 'string') return;
  try {
    const sessionId = await withSysReadDeadline(sysRedis.get(hostKey(host)));
    if (!sessionId || typeof sessionId !== 'string') return;
    const session = await readJson<DevTunnelSessionRecord>(sessionKey(sessionId));
    if (!session) return;
    const now = nowSec();
    const remaining = session.hardExpiresAt - now;
    // Past the hard cap → do NOT re-persist (would resurrect an expired session /
    // set a non-positive EX). Let the reaper + hard-TTL collect it.
    if (remaining <= 0) return;
    const updated: DevTunnelSessionRecord = { ...session, lastActivityAt: now };
    await sysRedis.set(sessionKey(sessionId), JSON.stringify(updated), { EX: remaining });
  } catch {
    /* best-effort idle refresh — never throw into the gate */
  }
}

// ---------------------------------------------------------------------------
// sish authz callback support
// ---------------------------------------------------------------------------

/** Look up the credential the sish authz callback presents (by pubkey
 *  fingerprint). Returns null when absent/expired. The CALLER does the
 *  constant-time full-pubkey compare — this is only the index read. */
export async function lookupCredentialByFingerprint(
  fingerprint: string
): Promise<DevTunnelCredentialRecord | null> {
  const cred = await readJson<DevTunnelCredentialRecord>(credKey(fingerprint));
  if (!cred) return null;
  if (cred.hardExpiresAt <= nowSec()) return null;
  return cred;
}

/**
 * SINGLE-USE consume: delete the credential index after a successful sish authz
 * so a REPLAYED authz POST is denied (the next lookup misses → deny). The
 * tunnel⇆userId binding (host / session records) persists for the session; only
 * the pubkey→credential authz index is one-time. Best-effort (a failed delete
 * leaves the credential, which the hard-TTL still expires) — never throws.
 */
export async function consumeDevTunnelCredential(fingerprint: string): Promise<void> {
  await sysRedis.del(credKey(fingerprint)).catch(() => {});
}

// ---------------------------------------------------------------------------
// Spend-cap backstop
// ---------------------------------------------------------------------------

export type ReserveDevSessionBuzzResult = { allowed: boolean; total: number };

/**
 * Reserve `costBuzz` against a dev SESSION's cumulative ceiling. Atomic INCRBY;
 * if the reservation would exceed `capBuzz` it is rolled back (DECRBY) and denied
 * — the safe direction for an abuse backstop. Fails CLOSED (denied) on any Redis
 * error, never silently bypasses. This is a BACKSTOP over the block-token
 * DEV_BUZZ_BUDGET_CAP + the per-user daily cap; the author still spends only
 * their OWN Buzz.
 *
 * ⚠️ NOT WIRED in P1 — dev-session Buzz is NOT capped yet. This tested primitive
 * has NO live call site: it is enforced at workflow-submit in P3 once the block
 * token carries a dev-session id. Real dev spend TODAY rides the existing
 * `/api/v1/blocks/dev-token` real-Buzz clamp (DEV_BUZZ_BUDGET_CAP + the per-user
 * daily cap), NOT this per-session ceiling. Do NOT assume this backstop is active.
 */
export async function reserveDevSessionBuzz(
  sessionId: string,
  costBuzz: number,
  capBuzz: number = DEV_TUNNEL_SESSION_BUZZ_CAP
): Promise<ReserveDevSessionBuzzResult> {
  const cost = Math.max(0, Math.ceil(costBuzz));
  const key = spendKey(sessionId);
  try {
    const total = await sysRedis.incrBy(key, cost);
    if (total <= cost) {
      // first write in this window — arm the TTL so it self-expires with the tunnel
      await sysRedis.expire(key, DEV_TUNNEL_HARD_SECONDS);
    }
    if (total > capBuzz) {
      await sysRedis.decrBy(key, cost).catch(() => {});
      return { allowed: false, total: total - cost };
    }
    return { allowed: true, total };
  } catch {
    // Fail closed — a Redis incident must never silently uncap dev spend.
    return { allowed: false, total: capBuzz };
  }
}

/**
 * Refund a previously-reserved dev-session `costBuzz` (best-effort DECRBY). Used
 * by the submit path when the workflow submit throws AFTER a successful
 * reservation, mirroring the per-user daily cap's refund-on-throw so a failed
 * submit doesn't permanently burn the session ceiling. Best-effort: a lost
 * refund only OVER-counts (a STRICTER backstop) and never throws into the caller.
 */
export async function refundDevSessionBuzz(sessionId: string, costBuzz: number): Promise<void> {
  const cost = Math.max(0, Math.ceil(costBuzz));
  if (cost === 0) return;
  await sysRedis.decrBy(spendKey(sessionId), cost).catch(() => {
    /* best-effort — a lost refund over-counts (stricter cap) */
  });
}

// ---------------------------------------------------------------------------
// Reaper (server-authoritative — NOT CLI-dependent)
// ---------------------------------------------------------------------------

/** A reaper session read that distinguishes a genuine ABSENCE (reap) from a
 *  transient read ERROR (skip) — `readJson` collapses both to null, which would
 *  let a Redis blip reap a LIVE route. */
type ReaperRead =
  | { status: 'ok'; session: DevTunnelSessionRecord }
  | { status: 'absent' }
  | { status: 'error' };

async function readSessionForReap(sessionId: string): Promise<ReaperRead> {
  let raw: string | null;
  try {
    raw = await withSysReadDeadline(sysRedis.get(sessionKey(sessionId)));
  } catch {
    return { status: 'error' };
  }
  if (raw == null) return { status: 'absent' };
  if (typeof raw !== 'string') return { status: 'error' };
  try {
    return { status: 'ok', session: JSON.parse(raw) as DevTunnelSessionRecord };
  } catch {
    // Corrupt JSON — ambiguous, don't reap on it.
    return { status: 'error' };
  }
}

/** Prefer the apiserver's clock (the LIST response `Date` header) over the pod's
 *  local clock for the min-age / idle windows, so a skewed pod can't over- or
 *  under-reap. Falls back to the local clock when the header is unavailable. */
function apiServerNowSec(res: Response): number {
  try {
    const d = (res as { headers?: { get?: (k: string) => string | null } }).headers?.get?.('date');
    if (typeof d === 'string' && d) {
      const t = Date.parse(d);
      if (Number.isFinite(t)) return Math.floor(t / 1000);
    }
  } catch {
    /* fall through */
  }
  return nowSec();
}

/** True iff the session has been idle longer than DEV_TUNNEL_IDLE_SECONDS.
 *  Falls back to `createdAt` when `lastActivityAt` is absent (never-visited). */
function isIdleExpired(session: DevTunnelSessionRecord, now: number): boolean {
  const activity =
    typeof session.lastActivityAt === 'number' ? session.lastActivityAt : session.createdAt;
  return now - activity > DEV_TUNNEL_IDLE_SECONDS;
}

/**
 * Discriminated result of one reaper sweep — matches the sibling reaper-schedule
 * contract (civitai #2928) BYTE-FOR-BYTE so its `reap-dev-tunnels` job + the
 * `dev_tunnel_reaper_runs_total{result}` metric compile + work unchanged against
 * this (superset) reaper. `listOk:false` (with the HTTP `status`) is the
 * SILENT-FAILURE fix: a non-2xx / unreachable LIST is surfaced DISTINCTLY instead
 * of masquerading as a healthy empty sweep (which would let the job record `ok`
 * on a permanent no-op). Do NOT return a bare `{swept,reaped}` — the job hard-reads
 * `result.listOk` (undefined ⇒ every healthy run mis-records `list_failed`).
 */
export type ReapResult = {
  swept: number;
  reaped: number;
  /** Sessions intentionally left this sweep (young/absent-guarded, or their
   *  session read errored) — retried next tick. */
  skipped: number;
  /** false ⇒ a label-scoped LIST failed (non-2xx, OR the call THREW: TLS-verify
   *  reject / DNS / connection-refused / timeout / missing SA token); the sweep
   *  did nothing and could not reclaim routes. */
  listOk: boolean;
  /** When listOk is false: the HTTP status of a non-2xx LIST, or the sentinel `0`
   *  when the LIST call THREW (API server unreachable — no HTTP status exists). */
  status?: number;
};

/** Sentinel `status` for a LIST that threw (API unreachable — no real HTTP
 *  status). Distinguishes "couldn't reach the apiserver" from a genuine non-2xx.
 *  Matches #2928's constant of the same name + value. */
const LIST_UNREACHABLE_STATUS = 0;

/**
 * Sweep the ephemeral dev-tunnel routes and tear down any whose backing session
 * is HARD-expired (8h max-TTL), IDLE-expired (no browser activity for
 * DEV_TUNNEL_IDLE_SECONDS — F3), or genuinely GONE from Redis. Bounded by the
 * number of live routes (label-scoped LIST). Server-authoritative: even if the
 * CLI crashes without calling stopDevTunnel, this sweep + the hard-TTL Redis
 * expiry reclaim the route. Driven by the `reap-dev-tunnels` periodic job (#2928).
 *
 * Hardening (preserved + extended — this is the SUPERSET of #2928's reaper,
 * returning #2928's EXACT {@link ReapResult} contract):
 *   - CONTRACT (non-regressing): an errored or unreachable LIST is
 *     `{listOk:false, status}`, NEVER a silent `{swept:0,reaped:0}` that the
 *     `reap-dev-tunnels` job would mis-record as a healthy `ok` run.
 *   - BOTH KINDS (F1-2): discover ingressroutes AND middlewares, then reap over the
 *     UNION of session ids. buildDevTunnelApplyScript applies the Middleware BEFORE
 *     the IngressRoute under `set -e`, so a failed IngressRoute apply can leave an
 *     orphan Middleware (session-labelled) while the mint aborts. LISTing routes
 *     only would never discover it → an unbounded (inert) leak. deleteDevTunnelRoute
 *     already deletes both kinds, so a middleware-only orphan gets fully cleaned.
 *   - read-error skip: a transient Redis read error SKIPS the session (counted in
 *     `skipped`) — reap only on a CONFIRMED absent/expired/idle record, never a blip.
 *   - min-age guard: an absent-record session whose EARLIEST discovered object is
 *     younger than DEV_TUNNEL_REAP_MIN_AGE_SECONDS — OR whose age can't be
 *     determined (mirrors #2928) — is SKIPPED (counted), not reaped: it may be
 *     mid-mint (render precedes persist).
 *   - apiserver-clock: the min-age + idle windows use the LIST response Date header.
 */
export async function reapExpiredDevTunnels(): Promise<ReapResult> {
  const ns = env.APPS_DEV_TUNNEL_ROUTE_NAMESPACE;
  const selector = encodeURIComponent(`${DEV_TUNNEL_LABEL}=true`);
  const listPaths = [
    `/apis/traefik.io/v1alpha1/namespaces/${ns}/ingressroutes?labelSelector=${selector}`,
    `/apis/traefik.io/v1alpha1/namespaces/${ns}/middlewares?labelSelector=${selector}`,
  ];

  // Resolve the in-pod target once. A getDp1Target throw (missing SA token / not
  // in-cluster) is "can't reach the apiserver" — surface as listOk:false with the
  // unreachable sentinel, NOT a propagated exception (which the job would
  // mis-attribute to `error` rather than `list_failed`).
  let target: Awaited<ReturnType<typeof getDp1Target>>;
  try {
    target = await getDp1Target();
  } catch {
    return { swept: 0, reaped: 0, skipped: 0, listOk: false, status: LIST_UNREACHABLE_STATUS };
  }

  // Discover sessions across BOTH kinds. Map sessionId → EARLIEST discovered
  // object creationTimestamp (seconds), used by the min-age guard (a session with
  // even one old object is not mid-mint; a freshly-created pair stays young).
  const discovered = new Map<string, number | undefined>();
  let apiNow = nowSec();
  for (const listPath of listPaths) {
    let listRes: Response;
    try {
      listRes = await k8sFetch(target, listPath, { method: 'GET' });
    } catch {
      // Couldn't even REACH the apiserver for this LIST — list_failed (unreachable),
      // never a silent empty sweep.
      return { swept: 0, reaped: 0, skipped: 0, listOk: false, status: LIST_UNREACHABLE_STATUS };
    }
    // A non-2xx LIST is a FAILURE (RBAC/ns/5xx), NOT an empty cluster — surface it
    // distinctly so the job records `list_failed` instead of a healthy `ok` no-op.
    if (!listRes.ok) {
      return { swept: 0, reaped: 0, skipped: 0, listOk: false, status: listRes.status };
    }
    apiNow = apiServerNowSec(listRes);
    const list = await unwrap<{
      items?: Array<{ metadata?: { labels?: Record<string, string>; creationTimestamp?: string } }>;
    }>(listRes);
    for (const it of list?.items ?? []) {
      const sessionId = it?.metadata?.labels?.[DEV_TUNNEL_SESSION_LABEL];
      if (!sessionId) continue;
      const parsed = Date.parse(it?.metadata?.creationTimestamp ?? '');
      const createdSec = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
      if (!discovered.has(sessionId)) {
        discovered.set(sessionId, createdSec);
      } else {
        const prev = discovered.get(sessionId);
        if (createdSec != null && (prev == null || createdSec < prev)) {
          discovered.set(sessionId, createdSec);
        }
      }
    }
  }

  let reaped = 0;
  let skipped = 0;
  for (const [sessionId, createdSec] of discovered) {
    const read = await readSessionForReap(sessionId);

    // read-error skip: a Redis blip must never reap a LIVE session.
    if (read.status === 'error') {
      skipped += 1;
      continue;
    }

    if (read.status === 'absent') {
      // min-age guard: a just-created object (or one whose age can't be
      // determined — createdSec undefined) may be mid-mint → skip, never reap.
      if (createdSec == null || apiNow - createdSec < DEV_TUNNEL_REAP_MIN_AGE_SECONDS) {
        skipped += 1;
        continue;
      }
      // Orphan (record genuinely gone, object old enough) — delete BOTH kinds.
      await deleteDevTunnelRoute(sessionId).catch(() => {});
      recordDevTunnelTeardown('reap-maxttl');
      reaped += 1;
      continue;
    }

    // status === 'ok': reap on hard-TTL OR idle expiry. A healthy non-expired
    // session is neither reaped nor `skipped` — it's a live route intentionally
    // kept (matches #2928: skipped counts read-error + guarded-absent only).
    const session = read.session;
    const hardExpired = session.hardExpiresAt <= apiNow;
    const idleExpired = isIdleExpired(session, apiNow);
    if (hardExpired || idleExpired) {
      await teardownSession(session, hardExpired ? 'reap-maxttl' : 'reap-idle').catch(() => {});
      reaped += 1;
    }
  }
  return { swept: discovered.size, reaped, skipped, listOk: true };
}
