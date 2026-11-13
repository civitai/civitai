/**
 * The adapter over a fixture catalog file, for local registry and conformance runs. No
 * database, no Redis: catalog from `REGISTRY_ADAPTER_FIXTURE` (re-read on every poll),
 * cursors in memory. Refuses to start in production. `pnpm run registry-adapter:fixture`.
 *
 *   REGISTRY_ADAPTER_FIXTURE               path of the fixture catalog JSON (required)
 *   REGISTRY_ADAPTER_PORT                  adapter HTTP/SSE port (default 7130)
 *   REGISTRY_ADAPTER_GRPC_PORT             adapter gRPC port (default 7131)
 *   REGISTRY_ADAPTER_POLL_SECONDS          poll interval (default 1)
 *
 * The app, release and service schemas are served on the adapter's own schema stream, as the live
 * adapter serves them.
 */
import { readCatalog } from '~/server/registry-adapter/catalog-source';
import { createPollingAdapter } from '~/server/registry-adapter/cursor';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import { composeAdapter, resolveFromCatalog } from '~/server/registry-adapter/doc-streams';
import { abortableSleep } from '~/utils/errorHandling';
import { SERVED_SCHEMAS, buildEntities } from '~/server/registry-adapter/entities';
import {
  createMemorySnapshotStore,
  fixtureCatalogDeps,
  fixtureDocSource,
  fixtureFile,
} from './fixture-source';
import { createGrpcServer, listenGrpc } from '~/server/registry-adapter/grpc';
import { createRegistryServer } from '~/server/registry-adapter/serve';
import { REGISTRY_NAMESPACE } from '~/server/registry-adapter/urn';
import { APP_STORAGE_ENABLED_FEATURES } from '~/shared/constants/block-storage.constants';

function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('registry-adapter fixture mode never runs in production');
  }
  const path = process.env.REGISTRY_ADAPTER_FIXTURE;
  if (!path) throw new Error('REGISTRY_ADAPTER_FIXTURE must name a fixture catalog file');
  const port = Number(process.env.REGISTRY_ADAPTER_PORT || 7130);
  const grpcPort = Number(process.env.REGISTRY_ADAPTER_GRPC_PORT || 7131);
  const pollMs = Number(process.env.REGISTRY_ADAPTER_POLL_SECONDS || 1) * 1000;
  const onError = (err: unknown) => console.error('registry-adapter (fixture):', err);

  const file = fixtureFile(path);
  const deps = fixtureCatalogDeps(file);
  const readApps = () => readCatalog(deps);
  const store = createMemorySnapshotStore();
  // Fixture mode exists to exercise the feed, so it turns the registry-export switch on for
  // itself, for the schema entities and the document streams alike; the live entrypoint uses the
  // platform's switch.
  const features = { ...APP_STORAGE_ENABLED_FEATURES, registryExport: true };
  const entities = createPollingAdapter({
    namespace: REGISTRY_NAMESPACE,
    serves: SERVED_SCHEMAS,
    read: async () =>
      buildEntities(await readApps(), {
        baseUrl: 'https://civitai.example',
        onSkip: (reason) => console.warn('registry-adapter (fixture):', reason),
        features,
      }),
    store,
    pollMs,
    sleep: abortableSleep,
    onError,
  });
  const docs = createDocFeed({
    source: fixtureDocSource(file),
    resolve: resolveFromCatalog(readApps, features),
    store,
    pollMs,
    sleep: abortableSleep,
    onError,
  });
  const adapter = composeAdapter(entities, docs);
  createRegistryServer(adapter, { onError }).listen(port, () =>
    console.log(`registry-adapter (fixture ${path}) on :${port}`)
  );
  void listenGrpc(createGrpcServer(adapter, { onError }), grpcPort).then((bound) =>
    console.log(`registry-adapter (fixture ${path}) gRPC on :${bound}`)
  );
}

main();
