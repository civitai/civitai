// Pieces of the `pnpm dev` feed-go launcher (launcher.mjs), kept free of process state so
// scripts/__tests__/dev-feed-go.test.ts can drive each one. Plain .mjs, run by node, never bundled.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';

import dotenv from 'dotenv';

/** Where `.github/workflows/feed-go-release.yml` publishes the binaries (public, no auth). */
export const RELEASE_BASE = 'https://github.com/civitai/civitai/releases/download';
export const TAG_PREFIX = 'feed-go-v';
/** The Flipt keys of the client's Go-transport flags (`feedGoTransport*` in feature-flags.service.ts). */
export const TRANSPORT_FLIPT_KEYS = ['feed-go-transport', 'feed-go-transport-model-getall'];

const SEMVER = /^\d+\.\d+\.\d+$/;

/** The pinned feed-go version: `version` of apps/feed-go/package.json (scripts/release-app.mjs bumps it). */
export function parseVersion(packageJsonText) {
  const v = JSON.parse(packageJsonText).version;
  if (typeof v !== 'string' || !SEMVER.test(v)) {
    throw new Error(`apps/feed-go/package.json has no x.y.z version (got ${JSON.stringify(v)})`);
  }
  return v;
}

const OS_NAMES = { linux: 'linux', darwin: 'darwin' };
const ARCH_NAMES = { x64: 'amd64', arm64: 'arm64' };

/** The release asset for a node `process.platform` / `process.arch`, or null when none is built. */
export function assetName(version, platform, arch) {
  const os = OS_NAMES[platform];
  const goarch = ARCH_NAMES[arch];
  if (!os || !goarch) return null;
  return `feed-go-v${version}-${os}-${goarch}`;
}

export function releaseUrls(version, asset) {
  const base = `${RELEASE_BASE}/${TAG_PREFIX}${version}`;
  return { binary: `${base}/${asset}`, sums: `${base}/SHA256SUMS` };
}

/** The digest SHA256SUMS (`sha256sum` output) lists for `asset`, or null. */
export function expectedSha256(sumsText, asset) {
  for (const line of sumsText.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m && m[2] === asset) return m[1];
  }
  return null;
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Whether `buf` is the `asset` SHA256SUMS lists. A missing entry is a failure, never a pass. */
export function verifyChecksum(buf, sumsText, asset) {
  const want = expectedSha256(sumsText, asset);
  if (!want) return { ok: false, reason: `SHA256SUMS has no entry for ${asset}` };
  if (sha256(buf) !== want) return { ok: false, reason: `checksum mismatch for ${asset}` };
  return { ok: true };
}

/**
 * FEED_GO_LOCAL: unset/`auto` = the pinned binary, else `go build` when Go is installed; `binary` /
 * `source` = only that; `off` = no feed-go (today's behaviour). Anything else is treated as `off`
 * with a warning: a typo must not start a service nobody asked for.
 */
export function resolveMode(value) {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '' || v === 'auto') return { mode: 'auto' };
  if (v === 'binary' || v === 'source') return { mode: v };
  if (v === 'off' || v === '0' || v === 'false') return { mode: 'off' };
  return { mode: 'off', warning: `unknown FEED_GO_LOCAL=${value} (auto|binary|source|off)` };
}

/**
 * The app's environment as `next dev` sees it: the real environment first, then the dotenv files in
 * Next's development order (first wins). No `$VAR` expansion.
 */
export function readAppEnv(root, processEnv) {
  /** @type {Record<string, string>} */
  const merged = {};
  for (const file of ['.env.development.local', '.env.local', '.env.development', '.env']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const parsed = dotenv.parse(readFileSync(path));
    for (const [k, v] of Object.entries(parsed)) if (!(k in merged)) merged[k] = v;
  }
  for (const [k, v] of Object.entries(processEnv)) if (v !== undefined) merged[k] = v;
  return merged;
}

/** App variables feed-go reads under the same name and meaning (apps/feed-go/.env.example). */
export const PASSTHROUGH_VARS = [
  'REDIS_URL',
  'REDIS_SYS_URL',
  'REDIS_SYS_SENTINELS',
  'REDIS_SYS_SENTINEL_NAME',
  'REDIS_SYS_SENTINEL_PASSWORD',
  'REDIS_SYS_READ_TIMEOUT_MS',
  'CACHE_KEY_NAMESPACE',
  'IMAGE_QUERY_CACHING',
  'SESSION_REVOCATION_CACHE',
  'AUTH_JWT_ISSUER',
  'AUTH_JWKS_URI',
  'AUTH_REQUIRE_IAT0',
  'AUTH_SESSION_COOKIE_MODE',
  'AUTH_SESSION_COOKIE_MODE_BY_SITE',
  'AUTH_LEGACY_READ',
  'CIVITAI_MODERATION_USER_ID',
  'TRPC_ORIGINS',
  'NEXTAUTH_URL',
  'SERVER_DOMAIN_GREEN',
  'SERVER_DOMAIN_GREEN_ALIASES',
  'SERVER_DOMAIN_BLUE',
  'SERVER_DOMAIN_BLUE_ALIASES',
  'SERVER_DOMAIN_RED',
  'SERVER_DOMAIN_RED_ALIASES',
  'REGION_RESTRICTION_CONFIG',
  'REGION_BLOCK_CONFIG',
  'FEED_SERVICE_URL',
  'NEXT_PUBLIC_IMAGE_LOCATION',
];

/** FEED_GO_* variables the launcher sets itself (never taken from the app's env). */
const LAUNCHER_OWNED = new Set(['FEED_GO_ADDR', 'FEED_GO_INTERNAL_ADDR', 'FEED_GO_FALLBACK_URL']);

/** OS variables a process needs to run at all; none carries a credential. */
export const OS_VARS = [
  'PATH',
  'HOME',
  'USER',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'SystemRoot',
];

/** Variables feed-go refuses to start without (internal/config Load). */
export const REQUIRED_VARS = [
  'DATABASE_REPLICA_URL',
  'REDIS_URL',
  'REDIS_SYS_URL',
  'AUTH_JWKS_URI',
  'AUTH_JWT_ISSUER',
];

const isTrue = (v) => (v ?? '').trim().toLowerCase() === 'true';

/**
 * feed-go's whole environment, built from an allow-list — never the app's environment wholesale,
 * which carries every secret the Node app has. `addr` / `internalAddr` are its listeners and
 * `fallbackUrl` the local Next it hands everything it does not answer to.
 */
export function buildFeedGoEnv(appEnv, { addr, internalAddr, fallbackUrl }) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const k of OS_VARS) if (appEnv[k]) out[k] = appEnv[k];
  for (const k of PASSTHROUGH_VARS) if (appEnv[k]) out[k] = appEnv[k];
  // The replica the Node path reads (dbRead). DATAPACKET_DATABASE_RO_URL is NOT passed: feed-go
  // prefers it, but locally it names a different database than the one Node reads the feed from.
  const replica = appEnv.DATABASE_REPLICA_URL || appEnv.DATABASE_URL;
  if (replica) out.DATABASE_REPLICA_URL = replica;
  // The primary only when write-back is on (the only thing that reads it).
  if (isTrue(appEnv.FEED_GO_CACHE_WRITEBACK) && appEnv.DATABASE_URL) {
    out.DATABASE_URL = appEnv.DATABASE_URL;
  }
  // The app defaults REDIS_CLUSTER to false, feed-go to true: pass the app's meaning explicitly.
  out.REDIS_CLUSTER = isTrue(appEnv.REDIS_CLUSTER) ? 'true' : 'false';
  // feed-go's own knobs, if the developer set any.
  for (const [k, v] of Object.entries(appEnv)) {
    if (k.startsWith('FEED_GO_') && !k.startsWith('FEED_GO_LOCAL') && !LAUNCHER_OWNED.has(k) && v) {
      out[k] = v;
    }
  }
  out.FEED_GO_ADDR = addr;
  out.FEED_GO_INTERNAL_ADDR = internalAddr;
  out.FEED_GO_FALLBACK_URL = fallbackUrl;
  return out;
}

/** The names (never values) of required variables `env` lacks. */
export function missingRequired(env) {
  return REQUIRED_VARS.filter((k) => !env[k]);
}

/**
 * FLIPT_LOCAL_OVERRIDES with the Go-transport keys added as `on`, unless the developer already
 * named them (either way): their own value always wins.
 */
export function mergeFliptOverrides(existing, keys = TRANSPORT_FLIPT_KEYS) {
  const parts = (existing ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const named = new Set(parts.map((p) => p.split('=')[0].trim()));
  for (const k of keys) if (!named.has(k)) parts.push(`${k}=on`);
  return parts.join(',');
}

/** Next's port: `-p N` / `--port N` / `--port=N`, else PORT, else 3000 (as `next dev`). */
export function nextPort(args, env) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '-p' || a === '--port') && args[i + 1]) return Number(args[i + 1]);
    if (a.startsWith('--port=')) return Number(a.slice('--port='.length));
  }
  return env.PORT ? Number(env.PORT) : 3000;
}

/**
 * The pinned binary: the cached copy if it still matches its SHA256SUMS, else downloaded from the
 * release and verified before it is written. A mismatch is refused, never run. `fetchImpl` is
 * injectable for tests. Resolves `{ ok: true, path, source }` or `{ ok: false, reason }`.
 * @returns {Promise<{ ok: boolean, path?: string, source?: string, reason?: string }>}
 */
export async function resolveBinary({
  version,
  platform,
  arch,
  cacheDir,
  fetchImpl = fetch,
  timeoutMs = 60_000,
}) {
  const asset = assetName(version, platform, arch);
  if (!asset) return { ok: false, reason: `no prebuilt feed-go for ${platform}/${arch}` };
  const dir = join(cacheDir, version);
  const binPath = join(dir, asset);
  const sumsPath = join(dir, 'SHA256SUMS');

  if (existsSync(binPath) && existsSync(sumsPath)) {
    const [bin, sums] = await Promise.all([readFile(binPath), readFile(sumsPath, 'utf8')]);
    if (verifyChecksum(bin, sums, asset).ok) return { ok: true, path: binPath, source: 'cache' };
    await rm(binPath, { force: true });
  }

  const urls = releaseUrls(version, asset);
  let sums;
  let bin;
  try {
    sums = await fetchText(fetchImpl, urls.sums, timeoutMs);
    bin = await fetchBuffer(fetchImpl, urls.binary, timeoutMs);
  } catch (err) {
    return { ok: false, reason: `download of ${TAG_PREFIX}${version} failed: ${err.message}` };
  }
  const check = verifyChecksum(bin, sums, asset);
  if (!check.ok) return { ok: false, reason: `${check.reason}; refusing to run it` };

  await mkdir(dir, { recursive: true });
  const tmp = `${binPath}.${process.pid}.tmp`;
  await writeFile(tmp, bin);
  await chmod(tmp, 0o755);
  await rename(tmp, binPath);
  await writeFile(sumsPath, sums);
  return { ok: true, path: binPath, source: 'download' };
}

async function fetchOk(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}
async function fetchText(fetchImpl, url, timeoutMs) {
  return (await fetchOk(fetchImpl, url, timeoutMs)).text();
}
async function fetchBuffer(fetchImpl, url, timeoutMs) {
  return Buffer.from(await (await fetchOk(fetchImpl, url, timeoutMs)).arrayBuffer());
}

/**
 * The loopback proxy `FEED_GO_LOCAL_URL` names. Next's rewrite sends `/api/trpc-go/<p>` here as
 * `/api/trpc/<p>` (Host = this proxy, x-forwarded-host = the browser's host). It restores the
 * browser's Host (feed-go and Next both read the domain color from it) and sends the request to
 * feed-go while `feedGo()` returns its address, else — and whenever feed-go cannot be reached — to
 * Next's own `/api/trpc/<p>`, which is today's behaviour. `onFeedGoError` hears a failed feed-go hop.
 */
export function createFeedGoProxy({ next, feedGo, onFeedGoError = () => {} }) {
  return http.createServer((req, res) => {
    const headers = { ...req.headers };
    if (headers['x-forwarded-host']) headers.host = headers['x-forwarded-host'];
    const toNext = () => forward(req, res, next, headers, () => fail(res));
    const target = feedGo();
    if (!target) return toNext();
    const replayable = req.method === 'GET' || req.method === 'HEAD';
    forward(req, res, target, headers, (err) => {
      onFeedGoError(err);
      if (replayable && !res.headersSent) toNext();
      else fail(res);
    });
  });
}

function forward(req, res, { host, port }, headers, onError) {
  const upstream = http.request(
    { host, port, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', onError);
  // A GET/HEAD carries no body, and its request stream may already have ended (the replay to Next
  // after a failed feed-go hop): end the upstream request directly instead of piping a spent stream.
  if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
  else req.pipe(upstream);
}

function fail(res) {
  if (res.headersSent) return res.destroy();
  res.writeHead(502, { 'content-type': 'text/plain' });
  res.end('feed-go dev proxy: upstream unreachable');
}
