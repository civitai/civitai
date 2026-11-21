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
 *   KEEP_ALIVE_TIMEOUT             the HTTP/SSE server's idle keep-alive timeout in ms (default
 *                                  100000, above a fronting proxy's 90 s; `serve.ts`)
 *   NEXT_PUBLIC_BASE_URL           the site origin the runtime record links to
 *   REGISTRY_ADAPTER_APP_SEARCH_URL
 *                                  the public app search endpoint; when set (an https: URL), the
 *                                  app search service entity is published on the `service`
 *                                  stream. Unset or empty publishes none; any other value refuses
 *                                  to start (`parseAppSearchUrl` in `entities.ts`)
 *   REGISTRY_ADAPTER_RESOURCE_URL  this source's public URL, its OAuth resource identifier; when
 *                                  set (with AUTH_JWT_ISSUER, the issuer whose tokens it
 *                                  accepts), protected resource metadata is served and named by
 *                                  every auth error (`auth.ts`). It is also the audience a hub
 *                                  access token must name; unset, no hub access token is accepted
 *   AUTH_JWT_ISSUER, AUTH_JWKS_URI the auth hub's issuer (default https://auth.civitai.com) and
 *                                  signing keys (default {issuer}/.well-known/jwks.json), for its
 *                                  exchanged access tokens (`auth.jwt.ts`)
 *   REGISTRY_ADAPTER_SERVICE_CLIENTS
 *                                  OAuth client ids (comma- or space-separated) whose service
 *                                  tokens (a client as itself, no user) are accepted, each
 *                                  reading every rating with no region hold (`audience.ts`).
 *                                  Unset or empty (the default): none, and every service token
 *                                  is invalid_token
 *   REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS, REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS_PER_TOKEN,
 *   REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS_PER_ADDRESS
 *                                  caps on open subscriptions, over both bindings (`limits.ts`)
 *   REGION_RESTRICTION_CONFIG, REGION_BLOCK_CONFIG
 *                                  the site's own region lists; both are held to SFW content
 *                                  here (`request-origin.ts`), and logged at startup. Unlike the
 *                                  site, a request with no region (no country header) is held
 *                                  to SFW as well
 *   REGISTRY_ADAPTER_PRIVATE_RELAYS
 *                                  the relays (the OAuth client ids they exchange tokens as, a
 *                                  token's `act.sub`; comma- or space-separated) whose users'
 *                                  tokens may read authorized PRIVATE document streams
 *                                  (`private-feed.ts`). Unset or empty, the default: no private
 *                                  stream exists, and every document stream is public
 *   REGISTRY_ADAPTER_LISTING_RELAYS
 *                                  the relays (OAuth client ids, a token's `act.sub`; comma- or
 *                                  space-separated) whose subscriptions may read the `listing@v1`
 *                                  stream (`listing-stream.ts`). Unset or empty, the default: the
 *                                  schema is not served, and the catalog read is unchanged
 *   REGISTRY_ADAPTER_TRUST_META    "1" to judge the region from a request's `meta` as well as its
 *                                  headers; set only once the gateway sets those keys itself
 *                                  (`request-origin.ts`)
 *   REGISTRY_ADAPTER_POLICY_URL    the content-policy service (apps/content-policy-go); when set,
 *                                  each subscription's decision is compared with the service's in
 *                                  SHADOW mode, never changed (`policy-shadow.ts`), and `/metrics`
 *                                  is served on REGISTRY_ADAPTER_METRICS_PORT (default 7132).
 *                                  REGISTRY_ADAPTER_POLICY_TIMEOUT_MS bounds one comparison
 *                                  (default 250). Unset: no comparison and no metrics port
 *   REGISTRY_ADAPTER_POLICY_ENFORCE "1" (with REGISTRY_ADAPTER_POLICY_URL): a signed-in user's
 *                                  subscription streams the service's audience instead, waiting
 *                                  at most the timeout above, and this source's own on any
 *                                  failure; anonymous and service principals stay local
 *                                  (`policy-enforce.ts`). Unset (the default): off
 *
 * Auth (the registry's auth extension, `auth.ts`): no token is anonymous; a civitai OAuth access
 * token is verified as every `/api/v1` route verifies it, and an access token the auth hub issued
 * for this source (a relay's token exchange) against the hub's keys (`auth.live.ts`). Each
 * document, app and app-release stream is narrowed to the apps whose rating its token's user may
 * read (`audience.ts`; none of the mature ones from a region the site restricts to SFW, or from a
 * request with no region), each entity still tagged with its rating, and so is the schema
 * stream's set of collection schemas (the fixed entity schemas go to everyone); the `service`
 * stream is the same for everyone.
 */
import { readCatalog } from '~/server/registry-adapter/catalog-source';
import { liveCatalogReadDeps } from '~/server/registry-adapter/catalog-source.live';
import { createPollingAdapter, sharedRead } from '~/server/registry-adapter/cursor';
import { abortableSleep } from '~/utils/errorHandling';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import { createGrpcServer, listenGrpc } from '~/server/registry-adapter/grpc';
import { liveSharedDocSource } from '~/server/registry-adapter/doc-source.live';
import {
  composeAdapter,
  resolveFromCatalog,
  resolvePrivateFromCatalog,
} from '~/server/registry-adapter/doc-streams';
import {
  PRIVATE_STATE_RETENTION_SECONDS,
  createPrivateDocFeed,
  parsePrivateRelays,
} from '~/server/registry-adapter/private-feed';
import {
  liveDecideCollectionRead,
  livePrivateDocSource,
  liveRunGateReadable,
} from '~/server/registry-adapter/private-feed.live';
import { STATES_KEPT_PER_STREAM } from '~/server/registry-adapter/cursor';
import { isSharedDocLevelsOn } from '~/server/services/apps/doc-levels';
import {
  APP_SEARCH_URN,
  buildEntitiesPerRead,
  parseAppSearchUrl,
  servedSchemas,
} from '~/server/registry-adapter/entities';
import { gateListings, parseListingRelays } from '~/server/registry-adapter/listing-stream';
import type { ResourceConfig } from '~/server/registry-adapter/auth';
import {
  createCivitaiTokenVerifier,
  parseServiceClients,
} from '~/server/registry-adapter/auth.live';
import {
  createSubscriptionLimiter,
  subscriptionLimitsFromEnv,
} from '~/server/registry-adapter/limits';
import { startPolicy } from '~/server/registry-adapter/policy-enforce';
import { createRegistryServer, keepAliveTimeoutFromEnv } from '~/server/registry-adapter/serve';
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
  const appSearchUrl = parseAppSearchUrl(process.env.REGISTRY_ADAPTER_APP_SEARCH_URL);
  console.log(
    appSearchUrl
      ? `registry-adapter: service ${APP_SEARCH_URN} at ${appSearchUrl}`
      : 'registry-adapter: app search not published (REGISTRY_ADAPTER_APP_SEARCH_URL unset)'
  );
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
  // /metrics is served only while the content-policy shadow is on (below), and carries only the
  // shadow counter, so the open-subscription count is a log line: checked every minute, logged when
  // it changed.
  let loggedOpen = -1;
  setInterval(() => {
    const open = limiter.open();
    if (open === loggedOpen) return;
    loggedOpen = open;
    console.log(`registry-adapter: open subscriptions: ${open}`);
  }, 60_000).unref();
  const serviceClients = parseServiceClients(process.env.REGISTRY_ADAPTER_SERVICE_CLIENTS);
  console.log(
    serviceClients.size === 0
      ? 'registry-adapter: service clients: none (REGISTRY_ADAPTER_SERVICE_CLIENTS unset)'
      : `registry-adapter: service clients: ${[...serviceClients].join(', ')}`
  );
  const verifyToken = createCivitaiTokenVerifier({
    resource: resourceUrl,
    issuer,
    jwksUri: process.env.AUTH_JWKS_URI,
    serviceClients,
  });
  if (!resourceUrl) {
    console.warn(
      'registry-adapter: WARNING: REGISTRY_ADAPTER_RESOURCE_URL is unset; no hub access token is accepted'
    );
  }
  const onRegion = (line: string) => console.log('registry-adapter:', line);
  // Shadow mode: off unless REGISTRY_ADAPTER_POLICY_URL is set; it never changes a decision.
  // Enforcement: off unless REGISTRY_ADAPTER_POLICY_ENFORCE=1 as well. A misconfiguration of
  // either never stops the adapter (`startPolicy`).
  const { shadow: policyShadow, enforce: policyEnforce } = startPolicy(process.env);
  const auth = { verifyToken, resource, limiter, onRegion, policyShadow, policyEnforce };

  const listingRelays = parseListingRelays(process.env.REGISTRY_ADAPTER_LISTING_RELAYS);
  const listings = listingRelays.size > 0;
  console.log(
    listings
      ? `registry-adapter: listing stream ON for relays: ${[...listingRelays].join(', ')}`
      : 'registry-adapter: listing stream off (REGISTRY_ADAPTER_LISTING_RELAYS unset)'
  );
  const served = servedSchemas({ listings });
  const deps = liveCatalogReadDeps({ listings });
  // Every subscription polls; they share one catalog read per half poll interval.
  const readApps = sharedRead(() => readCatalog(deps, { listings }), pollMs / 2);
  const store = createRedisSnapshotStore();
  const polling = createPollingAdapter({
    namespace: REGISTRY_NAMESPACE,
    serves: served,
    read: buildEntitiesPerRead(readApps, {
      baseUrl,
      appSearchUrl,
      listings,
      onSkip: (reason) => console.warn('registry-adapter:', reason),
    }),
    store,
    pollMs,
    sleep: abortableSleep,
    onError,
  });
  const entities = listings ? gateListings(polling, listingRelays) : polling;
  const docs = createDocFeed({
    source: liveSharedDocSource(),
    // Export only what content levels gate: an app whose levels flag is off publishes nothing.
    resolve: resolveFromCatalog(readApps, undefined, {
      docLevelsOn: isSharedDocLevelsOn,
      requireDocLevels: true,
    }),
    store,
    pollMs,
    sleep: abortableSleep,
    onError,
  });
  const privateRelays = parsePrivateRelays(process.env.REGISTRY_ADAPTER_PRIVATE_RELAYS);
  console.log(
    privateRelays.size > 0
      ? `registry-adapter: private streams ON for relays: ${[...privateRelays].join(', ')}`
      : 'registry-adapter: private streams off (REGISTRY_ADAPTER_PRIVATE_RELAYS unset)'
  );
  const privateDocs =
    privateRelays.size > 0
      ? createPrivateDocFeed({
          relays: privateRelays,
          source: livePrivateDocSource(),
          resolve: resolvePrivateFromCatalog(readApps),
          decide: liveDecideCollectionRead,
          runGateReadable: liveRunGateReadable,
          store: createRedisSnapshotStore(
            undefined,
            STATES_KEPT_PER_STREAM,
            PRIVATE_STATE_RETENTION_SECONDS
          ),
          pollMs,
          sleep: abortableSleep,
          onError,
        })
      : undefined;
  const adapter = composeAdapter(entities, docs, privateDocs);

  const server = createRegistryServer(adapter, {
    onError,
    ...auth,
    keepAliveTimeoutMs: keepAliveTimeoutFromEnv(process.env),
  });
  server.listen(port, () =>
    console.log(`registry-adapter: ${REGISTRY_NAMESPACE} serving ${served.join(', ')} on :${port}`)
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
