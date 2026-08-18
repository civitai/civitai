import type {
  ModeratorEndpointDoc,
  ModeratorMethod,
  ModeratorSpec,
  ProjectedSchema,
} from '~/server/utils/moderator-endpoint';
import { projectSchema, specToDoc } from '~/server/utils/moderator-endpoint';
import { MODERATOR_ENDPOINT_MODULES } from '~/server/utils/moderator-endpoint-catalog.generated';

// THE MODERATOR ENDPOINT CATALOG — what `/moderator/api` renders. A docs page that drifts from the API is
// worse than no docs page: it is a list of calls that used to work.
//
// The loaders are GENERATED — `pnpm run generate:moderator-endpoints`, run by hand after adding or
// removing an endpoint.
//
// Building the page DOES import every endpoint module, and with them every service those endpoints use:
// a spec lives on the handler, so reading one means evaluating the module. `import()` caches, so this is
// one warm-up per server process rather than per request, and those services load anyway the moment any
// of these endpoints is called. Decoupling it properly would mean moving each spec into a module the
// handler imports rather than the reverse — worth doing if this page ever needs to be cheap, and not
// done yet.
//
// What IS handled is the consequence: one module that throws on import must not take the page with it.

type EndpointModule = { default?: { spec?: ModeratorSpec; endpointName?: string } };

const ENDPOINTS = MODERATOR_ENDPOINT_MODULES as Record<string, () => Promise<EndpointModule>>;

export type CatalogEntry = {
  path: string;
  name: string;
  /** Absent when the module could not be loaded, or loaded but exported no spec. */
  doc?: ModeratorEndpointDoc;
  /** Set instead of `doc`. Rendered on the page — an endpoint that cannot be described is a finding,
   *  not something to omit, and omitting it would read as the endpoint not existing. */
  loadError?: string;
  /** The input schema projected to JSON Schema, kept alongside the flattened `doc.params` because
   *  OpenAPI needs the full shape — nested arrays, objects, enums — that flattening discards. */
  schema?: ProjectedSchema;
  method?: ModeratorMethod;
  privileged?: string;
};

/**
 * Every moderator endpoint, with the docs derived from the schema each one validates against.
 *
 * Unfiltered by viewer, unlike the spoke's catalog: every caller here is already a moderator, and an
 * endpoint's `privileged` key is shown rather than hidden — knowing a permission exists is how a
 * moderator knows what to ask for.
 */
/**
 * Drops keys whose value is `undefined`, at any depth.
 *
 * This is consumed by `getServerSideProps`, which REFUSES to serialise `undefined` and fails the
 * whole page rather than the one field. That has broken this page three times now — once in
 * `specToDoc`, once on `privileged` here, and a projected schema is a third surface nobody controls,
 * since it comes out of zod. Fixing each site as it appears has not worked, so the boundary is
 * normalised instead: absent means the key is missing, which is what a JSON consumer expects.
 */
export function jsonSafe<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;

  // An `undefined` ELEMENT becomes null rather than being dropped: removing it would shift every
  // later index, and null is what JSON.stringify does with a hole anyway.
  if (Array.isArray(value)) {
    return value.map((v) => (v === undefined ? null : jsonSafe(v))) as unknown as T;
  }

  // PLAIN objects only. A Date — or any class instance — walked as a bag of keys comes back as `{}`,
  // its value silently lost, which is a worse bug than the `undefined` this exists to prevent.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) out[k] = jsonSafe(v);
  }
  return out as T;
}

export async function moderatorEndpointCatalog(): Promise<CatalogEntry[]> {
  const entries = await Promise.all(
    Object.entries(ENDPOINTS).map(async ([path, load]): Promise<CatalogEntry> => {
      try {
        const mod = await load();
        const spec = mod.default?.spec;
        // Matched the generator's marker but exported no spec — a hand-rolled handler in a directory the
        // generator scans, most likely. Reported rather than skipped, because a silent omission is
        // indistinguishable from the endpoint not being there.
        if (!spec) {
          return { path, name: path, loadError: 'Loaded, but exported no endpoint spec.' };
        }
        return {
          path,
          name: mod.default?.endpointName ?? path,
          doc: specToDoc(spec),
          method: spec.method,
          ...(spec.privileged ? { privileged: spec.privileged } : {}),
          ...(spec.input ? { schema: projectSchema(spec.input) } : {}),
        };
      } catch (e) {
        console.error(`[moderator-endpoint-catalog] ${path} could not be loaded`, e);
        return { path, name: path, loadError: (e as Error)?.message ?? String(e) };
      }
    })
  );

  return entries.map(jsonSafe).sort((a, b) => a.path.localeCompare(b.path));
}
