/**
 * Entrypoint of the registry adapter for Civitai apps: a process of its own, separate from the
 * web tier, serving the registry source protocol over HTTP/SSE. `pnpm run registry-adapter`.
 *
 * Environment: the app's server env (database read client, Redis), plus
 *   REGISTRY_ADAPTER_PORT          listen port (default 7130)
 *   REGISTRY_ADAPTER_POLL_SECONDS  how often a subscription re-reads the catalog (default 60)
 *   NEXT_PUBLIC_BASE_URL           the site origin the runtime record links to
 */
import { readCatalog } from '~/server/registry-adapter/catalog-source';
import { liveCatalogReadDeps } from '~/server/registry-adapter/catalog-source.live';
import { abortableSleep, createPollingAdapter, sharedRead } from '~/server/registry-adapter/cursor';
import { SERVED_SCHEMAS, buildEntities } from '~/server/registry-adapter/entities';
import { createRegistryServer } from '~/server/registry-adapter/serve';
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
  const pollMs = positiveNumber('REGISTRY_ADAPTER_POLL_SECONDS', 60) * 1000;
  const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || 'https://civitai.com').replace(/\/$/, '');
  const onError = (err: unknown) => console.error('registry-adapter:', err);

  const deps = liveCatalogReadDeps();
  // Every subscription polls; they share one catalog read per half poll interval.
  const read = sharedRead(
    async () => buildEntities(await readCatalog(deps), { baseUrl }),
    pollMs / 2
  );
  const adapter = createPollingAdapter({
    namespace: REGISTRY_NAMESPACE,
    serves: SERVED_SCHEMAS,
    read,
    store: createRedisSnapshotStore(),
    pollMs,
    sleep: abortableSleep,
    onError,
  });

  const server = createRegistryServer(adapter, { onError });
  server.listen(port, () =>
    console.log(
      `registry-adapter: ${REGISTRY_NAMESPACE} serving ${SERVED_SCHEMAS.join(', ')} on :${port}`
    )
  );
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
