/**
 * Entrypoint of the registry adapter for Civitai apps: a process of its own, separate from the
 * web tier, serving the registry source protocol over both of its bindings, HTTP/SSE and gRPC,
 * from one adapter. Built with `pnpm run build:registry-adapter` and run as
 * `node dist/registry-adapter.js`.
 *
 * Environment: the app's server env (database read client, Redis, and the App Blocks datastore
 * connection for the shared-document feed), plus
 *   REGISTRY_ADAPTER_PORT          HTTP/SSE listen port (default 7130)
 *   REGISTRY_ADAPTER_GRPC_PORT     gRPC listen port (default 7131; see `grpc.ts` for why it is
 *                                  a port of its own)
 *   REGISTRY_ADAPTER_POLL_SECONDS  how often a subscription re-reads the catalog
 *   NEXT_PUBLIC_BASE_URL           the site origin the runtime record links to
 *   REGISTRY_ADAPTER_RESOURCE_URL  this source's public URL, its OAuth resource identifier; when
 *                                  set (with AUTH_JWT_ISSUER, the issuer whose tokens it
 *                                  accepts), protected resource metadata is served and named by
 *                                  every auth error (`auth.ts`)
 *   REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS, REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS_PER_TOKEN,
 *   REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS_PER_ADDRESS
 *                                  caps on open subscriptions, over both bindings (`limits.ts`)
 *   REGION_RESTRICTION_CONFIG, REGION_BLOCK_CONFIG
 *                                  the site's own region lists; both are held to SFW content
 *                                  here (`request-origin.ts`), and logged at startup
 *
 * Auth (the registry's auth extension, `auth.ts`): no token is anonymous; a civitai OAuth access
 * token is verified as every `/api/v1` route verifies it (`auth.live.ts`). Each document, app and
 * app-release stream is narrowed to the apps whose rating its token's user may read
 * (`audience.ts`; none of the mature ones from a region the site restricts to SFW), each entity still tagged with its rating, and so is the schema stream's set of
 * collection schemas (the fixed entity schemas go to everyone); the `service` stream is the same
 * for everyone.
 */
import { readCatalog } from '~/server/registry-adapter/catalog-source';
import { liveCatalogReadDeps } from '~/server/registry-adapter/catalog-source.live';
import { createPollingAdapter, sharedRead } from '~/server/registry-adapter/cursor';
import { abortableSleep } from '~/utils/errorHandling';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import { createGrpcServer, listenGrpc } from '~/server/registry-adapter/grpc';
import { liveSharedDocSource } from '~/server/registry-adapter/doc-source.live';
import { composeAdapter, resolveFromCatalog } from '~/server/registry-adapter/doc-streams';
import { SERVED_SCHEMAS, buildEntitiesPerRead } from '~/server/registry-adapter/entities';
import type { ResourceConfig } from '~/server/registry-adapter/auth';
import { verifyCivitaiToken } from '~/server/registry-adapter/auth.live';
import {
  createSubscriptionLimiter,
  subscriptionLimitsFromEnv,
} from '~/server/registry-adapter/limits';
import { createRegistryServer } from '~/server/registry-adapter/serve';
import { describeRegionConfig } from '~/server/registry-adapter/request-origin';
import { createRedisSnapshotStore } from '~/server/registry-adapter/snapshot-store.redis';
import { REGISTRY_NAMESPACE } from '~/server/registry-adapter/urn';

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

function main() {
  const port = positiveNumber('REGISTRY_ADAPTER_PORT', 7130);
  const grpcPort = positiveNumber('REGISTRY_ADAPTER_GRPC_PORT', 7131);
  const pollMs = positiveNumber('REGISTRY_ADAPTER_POLL_SECONDS', 60) * 1000;
  const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || 'https://civitai.com').replace(/\/$/, '');
  const onError = (err: unknown) => console.error('registry-adapter:', err);
  const resourceUrl = process.env.REGISTRY_ADAPTER_RESOURCE_URL;
  const issuer = process.env.AUTH_JWT_ISSUER;
  const resource: ResourceConfig | undefined =
    resourceUrl && issuer
      ? { resource: resourceUrl, issuers: [issuer.replace(/\/+$/, '')] }
      : undefined;
  // The region lists in force, so a missing configuration shows in the log; never fatal.
  const regions = describeRegionConfig();
  for (const line of regions.info) console.log('registry-adapter:', line);
  for (const line of regions.warn) console.warn('registry-adapter: WARNING:', line);
  // One limiter for both bindings, so its total counts every open stream of the process.
  const limiter = createSubscriptionLimiter(subscriptionLimitsFromEnv(process.env));
  const auth = { verifyToken: verifyCivitaiToken, resource, limiter };

  const deps = liveCatalogReadDeps();
  // Every subscription polls; they share one catalog read per half poll interval.
  const readApps = sharedRead(() => readCatalog(deps), pollMs / 2);
  const store = createRedisSnapshotStore();
  const entities = createPollingAdapter({
    namespace: REGISTRY_NAMESPACE,
    serves: SERVED_SCHEMAS,
    read: buildEntitiesPerRead(readApps, {
      baseUrl,
      onSkip: (reason) => console.warn('registry-adapter:', reason),
    }),
    store,
    pollMs,
    sleep: abortableSleep,
    onError,
  });
  const docs = createDocFeed({
    source: liveSharedDocSource(),
    resolve: resolveFromCatalog(readApps),
    store,
    pollMs,
    sleep: abortableSleep,
    onError,
  });
  const adapter = composeAdapter(entities, docs);

  const server = createRegistryServer(adapter, { onError, ...auth });
  server.listen(port, () =>
    console.log(
      `registry-adapter: ${REGISTRY_NAMESPACE} serving ${SERVED_SCHEMAS.join(', ')} on :${port}`
    )
  );
  const grpcServer = createGrpcServer(adapter, { onError, ...auth });
  listenGrpc(grpcServer, grpcPort).then(
    (bound) => console.log(`registry-adapter: gRPC on :${bound}`),
    (err: unknown) => {
      console.error('registry-adapter: gRPC could not listen:', err);
      process.exit(1);
    }
  );
  const stop = () => {
    grpcServer.forceShutdown();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
