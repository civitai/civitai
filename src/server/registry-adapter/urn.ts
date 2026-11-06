/**
 * The adapter's namespace and the one function that builds every URN in it.
 *
 * @ai: the namespace is PENDING a decision by the registry's owners. `civitai` is taken by
 * another source and `apps` by the registry's demo; `civitai-apps` is a placeholder. URNs are
 * never rewritten once a registry has seen them, so change it here, before anything consumes it.
 */
export const REGISTRY_NAMESPACE = 'civitai-apps';

/** Schemas this adapter claims but does not define: they belong to the shared schemas source. */
export const REGISTRY_SCHEMA_SCHEMA = 'urn:schema:registry:schema@v1';
export const APP_SCHEMA = 'urn:schema:civitai-schemas:app@v1';
export const APP_RELEASE_SCHEMA = 'urn:schema:civitai-schemas:app-release@v1';
export const SERVICE_SCHEMA = 'urn:schema:civitai-schemas:service@v1';

export type UrnRef =
  | { kind: 'app'; slug: string }
  | { kind: 'release'; slug: string; version: string }
  | { kind: 'collection-schema'; slug: string; collection: string; major: number }
  | { kind: 'document'; slug: string; collection: string; key: string }
  | { kind: 'runtime'; name: string; major: number };

// A segment never contains `:`, `/` or `@`, so every URN parses back unambiguously.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const COLLECTION_RE = /^[a-z][a-z0-9_]*$/;
const VERSION_RE = /^[0-9A-Za-z.+-]+$/;
// The store's own key shape: no `/` or `@`, so a document URN still parses back.
const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function segment(value: string, re: RegExp, what: string): string {
  if (!re.test(value)) throw new Error(`registry urn: invalid ${what} ${JSON.stringify(value)}`);
  return value;
}

function major(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new Error(`registry urn: invalid major ${n}`);
  return n;
}

export function registryUrn(ref: UrnRef): string {
  switch (ref.kind) {
    case 'app':
      return `urn:${REGISTRY_NAMESPACE}:app/${segment(ref.slug, SLUG_RE, 'slug')}`;
    case 'release':
      return `urn:${REGISTRY_NAMESPACE}:app/${segment(ref.slug, SLUG_RE, 'slug')}@${segment(
        ref.version,
        VERSION_RE,
        'version'
      )}`;
    case 'collection-schema':
      return `urn:schema:${REGISTRY_NAMESPACE}:${segment(ref.slug, SLUG_RE, 'slug')}/${segment(
        ref.collection,
        COLLECTION_RE,
        'collection'
      )}@v${major(ref.major)}`;
    case 'document':
      return `urn:${REGISTRY_NAMESPACE}:${segment(ref.slug, SLUG_RE, 'slug')}/${segment(
        ref.collection,
        COLLECTION_RE,
        'collection'
      )}/${segment(ref.key, KEY_RE, 'key')}`;
    case 'runtime':
      return `urn:${REGISTRY_NAMESPACE}:runtime/${segment(ref.name, SLUG_RE, 'runtime')}@${major(
        ref.major
      )}`;
  }
}

/** The parts of a collection-schema URN this adapter would issue, or null for any other URN. */
export function parseCollectionSchemaUrn(
  urn: string
): { slug: string; collection: string; major: number } | null {
  const prefix = `urn:schema:${REGISTRY_NAMESPACE}:`;
  if (!urn.startsWith(prefix)) return null;
  const m = /^([^/@]+)\/([^/@]+)@v([1-9][0-9]{0,8})$/.exec(urn.slice(prefix.length));
  if (!m || !SLUG_RE.test(m[1]) || !COLLECTION_RE.test(m[2])) return null;
  return { slug: m[1], collection: m[2], major: Number(m[3]) };
}
