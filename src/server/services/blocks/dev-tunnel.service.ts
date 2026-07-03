import { env } from '~/env/server';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { newBlockInstanceId } from '~/server/utils/app-block-ids';
import {
  getDp1Target,
  k8sFetch,
  unwrap,
  type K8sTarget,
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

/**
 * Read outcome that distinguishes a CONFIRMED-ABSENT key (`ok:true, value:null`)
 * from a Redis READ FAILURE (`ok:false`). The reaper MUST use this — not the
 * error→null `readJson` — for its reap decision: collapsing a read failure to
 * null would let a transient Redis blip mid-sweep be read as "session gone →
 * delete route" and tear down ALL active tunnels whose read happened to error.
 */
type SessionReadOutcome =
  | { ok: true; value: DevTunnelSessionRecord | null }
  | { ok: false };

async function readSessionChecked(sessionId: string): Promise<SessionReadOutcome> {
  try {
    const raw = await withSysReadDeadline(sysRedis.get(sessionKey(sessionId)));
    // A clean miss: the key is genuinely absent (the read SUCCEEDED and returned
    // nothing) — reap-eligible, subject to the min-age guard.
    if (!raw || typeof raw !== 'string') return { ok: true, value: null };
    try {
      return { ok: true, value: JSON.parse(raw) as DevTunnelSessionRecord };
    } catch {
      // Present-but-corrupt value — a confirmed-bad record, not a read failure.
      // Treat as absent (still min-age guarded before any delete).
      return { ok: true, value: null };
    }
  } catch {
    // Redis READ FAILURE (timeout / connection error). NOT a confirmed absence —
    // the route may back a live session. The caller must SKIP, never reap.
    return { ok: false };
  }
}

/** Elapsed seconds since a k8s object's `creationTimestamp`, or null if it's
 *  missing/unparseable (in which case the reaper conservatively skips a
 *  confirmed-absent route rather than risk the create-before-persist race). */
function routeAgeSeconds(creationTimestamp: string | undefined): number | null {
  if (!creationTimestamp) return null;
  const created = Date.parse(creationTimestamp);
  if (Number.isNaN(created)) return null;
  return Math.floor((Date.now() - created) / 1000);
}

/** Discriminated result of one reaper sweep. `listOk:false` (with the HTTP
 *  `status`) is the SILENT-FAILURE fix: a non-2xx LIST is surfaced distinctly
 *  instead of masquerading as a healthy empty sweep. */
export type ReapResult = {
  swept: number;
  reaped: number;
  /** Routes intentionally left this sweep (young/absent-guarded, or their session
   *  read errored) — retried next tick. */
  skipped: number;
  /** false ⇒ the label-scoped LIST returned a non-2xx; the sweep did nothing and
   *  the reaper could not reclaim routes. */
  listOk: boolean;
  /** HTTP status of the LIST when listOk is false. */
  status?: number;
};

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
};

/** Build the ephemeral forwardAuth Middleware for a dev-tunnel host. The
 *  Middleware points Traefik at the dev-tunnel-gate endpoint, which requires the
 *  parent-minted author-bound entry token on the ENTRY document (T3). */
export function buildDevTunnelMiddleware(opts: DevTunnelManifestOpts) {
  const name = `dev-tunnel-gate-${opts.sessionId}`;
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
  const name = `dev-tunnel-${opts.sessionId}`;
  const middlewareName = `dev-tunnel-gate-${opts.sessionId}`;
  // Split the backend into host:port for the Traefik ExternalName-style service
  // reference is not needed — Traefik IngressRoute services reference an in-ns
  // Service by name+port. The sish backend is a Service in the sish namespace, so
  // we use a Traefik `services[].name` + `namespace`. Parse host/port defensively.
  const backend = parseBackend(opts.sishBackend);
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
    },
    spec: {
      entryPoints: ['websecure'],
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
      tls: {},
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
    namespace: env.APPS_KUBE_NAMESPACE,
    forwardAuthUrl: forwardAuthUrl(),
    sishBackend: sishBackend(),
  };
}

// ---------------------------------------------------------------------------
// k8s apply / delete (thin, reuses apps-pipeline helpers)
// ---------------------------------------------------------------------------

async function applyManifest(target: K8sTarget, ns: string, kindPath: string, obj: unknown, name: string) {
  // Delete-then-create so a re-render of the same session name is idempotent
  // (mirrors the review apply Job's pre-delete). 404 on delete is fine.
  await k8sFetch(target, `${kindPath}/${name}?propagationPolicy=Background`, {
    method: 'DELETE',
  }).then(async (r) => {
    if (!r.ok && r.status !== 404) {
      const body = await r.text().catch(() => '');
      throw new Error(`dev-tunnel pre-delete ${name} ${r.status}: ${body.slice(0, 200)}`);
    }
  });
  const res = await k8sFetch(target, kindPath, { method: 'POST', body: JSON.stringify(obj) });
  await unwrap<{ metadata: { name: string } }>(res);
}

/** Render the ephemeral Traefik IngressRoute + forwardAuth Middleware for a
 *  dev-tunnel host by POSTing them directly to the k8s API (the same in-pod SA
 *  surface + create/delete RBAC the review teardown uses — no bash render Job, no
 *  template ConfigMap dependency). */
export async function renderDevTunnelRoute(host: string, sessionId: string): Promise<void> {
  const target = await getDp1Target();
  const ns = env.APPS_KUBE_NAMESPACE;
  const opts = manifestOpts(host, sessionId);
  const mw = buildDevTunnelMiddleware(opts);
  const ir = buildDevTunnelIngressRoute(opts);
  await applyManifest(
    target,
    ns,
    `/apis/traefik.io/v1alpha1/namespaces/${ns}/middlewares`,
    mw,
    mw.metadata.name
  );
  await applyManifest(
    target,
    ns,
    `/apis/traefik.io/v1alpha1/namespaces/${ns}/ingressroutes`,
    ir,
    ir.metadata.name
  );
}

/** Delete the ephemeral Traefik route for ONE session by label selector. Scoped
 *  to `civitai.com/dev-tunnel-session=<id>` so it can only ever touch THAT
 *  session's objects, never a live app. Best-effort + idempotent. */
export async function deleteDevTunnelRoute(sessionId: string): Promise<void> {
  const target = await getDp1Target();
  const ns = env.APPS_KUBE_NAMESPACE;
  const selector = encodeURIComponent(`${DEV_TUNNEL_SESSION_LABEL}=${sessionId}`);
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
      const list = await unwrap<{ items?: Array<{ metadata?: { name?: string } }> }>(listRes);
      const names = (list?.items ?? [])
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

// ---------------------------------------------------------------------------
// Reaper (server-authoritative — NOT CLI-dependent)
// ---------------------------------------------------------------------------

/**
 * Sweep the ephemeral dev-tunnel routes and tear down any whose backing session
 * record has genuinely expired (hard-TTL) or is confirmed-absent. Bounded by the
 * number of live routes (label-scoped LIST). Server-authoritative: even if the
 * CLI crashes without calling stopDevTunnel, the hard-TTL Redis expiry + this
 * sweep reclaim the route. Driven by the `reap-dev-tunnels` periodic job.
 *
 * SAFETY (the delete blast-radius is the whole point of a reaper — it must be
 * tight):
 *  - **LIST failure is NOT an empty sweep.** A non-2xx LIST returns
 *    `{ listOk:false, status }` (not a benign zero) so a persistent RBAC/ns/5xx
 *    failure is detectable + alertable rather than a silent permanent no-op.
 *  - **Never reap on a Redis READ FAILURE.** The reap decision uses
 *    `readSessionChecked` (error vs absent), not the error→null `readJson`. On a
 *    read error the route is SKIPPED — a transient Redis blip can never be read
 *    as "session gone → delete" and tear down live tunnels.
 *  - **Confirmed-absent record → min-age guarded.** A route whose session read
 *    cleanly missed is only reaped once it's older than
 *    DEV_TUNNEL_REAP_MIN_AGE_SECONDS, closing the create-before-persist race
 *    (route rendered before the session key is written).
 *
 * A present record is reaped only when `hardExpiresAt <= now` (`reap-maxttl`).
 * (A finer idle-timeout would refresh the session key's TTL on browser activity;
 * the absent-key path then reaps it — same code path, min-age guarded.)
 */
export async function reapExpiredDevTunnels(): Promise<ReapResult> {
  const target = await getDp1Target();
  const ns = env.APPS_KUBE_NAMESPACE;
  const selector = encodeURIComponent(`${DEV_TUNNEL_LABEL}=true`);
  const listRes = await k8sFetch(
    target,
    `/apis/traefik.io/v1alpha1/namespaces/${ns}/ingressroutes?labelSelector=${selector}`,
    { method: 'GET' }
  );
  // A non-2xx LIST is a FAILURE, not an empty sweep — surface it distinctly so
  // the job logs `level:error` + increments the `list_failed` metric. Returning a
  // benign zero here would make an RBAC/ns/5xx break a permanent silent no-op.
  if (!listRes.ok) {
    return { swept: 0, reaped: 0, skipped: 0, listOk: false, status: listRes.status };
  }
  const list = await unwrap<{
    items?: Array<{
      metadata?: { labels?: Record<string, string>; creationTimestamp?: string };
    }>;
  }>(listRes);
  const items = list?.items ?? [];
  let reaped = 0;
  let skipped = 0;
  for (const it of items) {
    const sessionId = it?.metadata?.labels?.[DEV_TUNNEL_SESSION_LABEL];
    if (!sessionId) continue;
    const outcome = await readSessionChecked(sessionId);
    if (!outcome.ok) {
      // Redis READ FAILED — this route may back a LIVE session. Never reap on a
      // read failure; skip and let the next sweep retry.
      skipped += 1;
      continue;
    }
    const session = outcome.value;
    if (session) {
      // Record present: reap ONLY if genuinely past its hard-TTL.
      if (session.hardExpiresAt <= nowSec()) {
        await teardownSession(session, 'reap-maxttl').catch(() => {});
        reaped += 1;
      }
      continue;
    }
    // Record CONFIRMED-ABSENT (clean miss or corrupt value). Guard the
    // create-before-persist race: only reap a route demonstrably older than the
    // min-age guard. A young route (or one whose age can't be determined) is left
    // for the next sweep.
    const ageSec = routeAgeSeconds(it?.metadata?.creationTimestamp);
    if (ageSec === null || ageSec < DEV_TUNNEL_REAP_MIN_AGE_SECONDS) {
      skipped += 1;
      continue;
    }
    // Redis record gone but route survives past the guard — delete it directly.
    await deleteDevTunnelRoute(sessionId).catch(() => {});
    recordDevTunnelTeardown('reap-maxttl');
    reaped += 1;
  }
  return { swept: items.length, reaped, skipped, listOk: true };
}
