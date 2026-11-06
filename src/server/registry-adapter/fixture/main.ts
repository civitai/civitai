/**
 * The adapter over a fixture catalog file, for local registry and conformance runs. No
 * database, no Redis: catalog from `REGISTRY_ADAPTER_FIXTURE` (re-read on every poll),
 * cursors in memory. Refuses to start in production. `pnpm run registry-adapter:fixture`.
 *
 *   REGISTRY_ADAPTER_FIXTURE               path of the fixture catalog JSON (required)
 *   REGISTRY_ADAPTER_PORT                  adapter port (default 7130)
 *   REGISTRY_ADAPTER_POLL_SECONDS          poll interval (default 1)
 *   REGISTRY_ADAPTER_SCHEMAS_PORT          also serve the draft shared schemas on this port
 */
import { readCatalog } from '~/server/registry-adapter/catalog-source';
import { abortableSleep, createPollingAdapter } from '~/server/registry-adapter/cursor';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import { composeAdapter, resolveFromCatalog } from '~/server/registry-adapter/doc-streams';
import { SERVED_SCHEMAS, buildEntities } from '~/server/registry-adapter/entities';
import {
  createMemorySnapshotStore,
  fixtureCatalogDeps,
  fixtureDocSource,
  fixtureFile,
} from '~/server/registry-adapter/fixture/fixture-source';
import {
  SHARED_SCHEMA_NAMESPACE,
  sharedSchemaEntities,
} from '~/server/registry-adapter/fixture/shared-schemas.fixture';
import { createRegistryServer } from '~/server/registry-adapter/serve';
import { REGISTRY_NAMESPACE, REGISTRY_SCHEMA_SCHEMA } from '~/server/registry-adapter/urn';

function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('registry-adapter fixture mode never runs in production');
  }
  const path = process.env.REGISTRY_ADAPTER_FIXTURE;
  if (!path) throw new Error('REGISTRY_ADAPTER_FIXTURE must name a fixture catalog file');
  const port = Number(process.env.REGISTRY_ADAPTER_PORT || 7130);
  const pollMs = Number(process.env.REGISTRY_ADAPTER_POLL_SECONDS || 1) * 1000;
  const onError = (err: unknown) => console.error('registry-adapter (fixture):', err);

  const file = fixtureFile(path);
  const deps = fixtureCatalogDeps(file);
  const readApps = () => readCatalog(deps);
  const store = createMemorySnapshotStore();
  const entities = createPollingAdapter({
    namespace: REGISTRY_NAMESPACE,
    serves: SERVED_SCHEMAS,
    read: async () => buildEntities(await readApps(), { baseUrl: 'https://civitai.example' }),
    store,
    pollMs,
    sleep: abortableSleep,
    onError,
  });
  const docs = createDocFeed({
    source: fixtureDocSource(file),
    resolve: resolveFromCatalog(readApps),
    store,
    pollMs,
    sleep: abortableSleep,
    onError,
  });
  const adapter = composeAdapter(entities, docs);
  createRegistryServer(adapter, { onError }).listen(port, () =>
    console.log(`registry-adapter (fixture ${path}) on :${port}`)
  );

  const schemasPort = process.env.REGISTRY_ADAPTER_SCHEMAS_PORT;
  if (schemasPort) {
    const schemas = createPollingAdapter({
      namespace: SHARED_SCHEMA_NAMESPACE,
      serves: [REGISTRY_SCHEMA_SCHEMA],
      read: async () => new Map([[REGISTRY_SCHEMA_SCHEMA, sharedSchemaEntities()]]),
      store: createMemorySnapshotStore(),
      pollMs,
      sleep: abortableSleep,
      onError,
    });
    createRegistryServer(schemas, { onError }).listen(Number(schemasPort), () =>
      console.log(`draft shared schemas (${SHARED_SCHEMA_NAMESPACE}) on :${schemasPort}`)
    );
  }
}

main();
