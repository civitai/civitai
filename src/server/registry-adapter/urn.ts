/**
 * The adapter's namespace and the one function that builds every URN in it.
 *
 * `apps.civitai.com`: a domain the operator controls, as the spec asks of a namespace that is not
 * a well-known name, so it cannot clash with anyone else's. URNs are never rewritten once a
 * registry has seen them, so settle any change here before a registry consumes them. Registry
 * issue #6 (URNs or https URLs as identifiers) may still change the identifier FORM; that would
 * be a mechanical change of these builders, with the namespace staying `apps.civitai.com`.
 *
 * Length: the longest URN built here is a document's, `urn:apps.civitai.com:` plus a 64-char
 * slug, a 32-char collection and a 128-char key with their two `/`: 247 characters.
 */
export const REGISTRY_NAMESPACE = 'apps.civitai.com';

/**
 * The namespace of a URN as the spec defines it: `{ns}` in `urn:{ns}:…`, or in `urn:schema:{ns}:…`
 * for a schema, with `{ns}` and what follows it non-empty. Null for a string of neither shape.
 */
export function urnNamespace(urn: string): string | null {
  const m = /^urn:(?:schema:)?([^:]+):.+$/.exec(urn);
  if (!m) return null;
  // `urn:schema:` alone names no namespace: `schema` is reserved for schemas.
  if (m[1] === 'schema') return null;
  return m[1];
}

/**
 * The schemas of the app, release and runtime entities. This adapter defines them
 * (`schemas.ts`) and publishes them as schema entities of its own namespace. None holds a `/`, so
 * none can be read as a collection schema URN ({@link parseCollectionSchemaUrn}).
 */
export const APP_SCHEMA = `urn:schema:${REGISTRY_NAMESPACE}:app@v1`;
export const APP_RELEASE_SCHEMA = `urn:schema:${REGISTRY_NAMESPACE}:app-release@v1`;
export const SERVICE_SCHEMA = `urn:schema:${REGISTRY_NAMESPACE}:service@v1`;

export type UrnRef =
  | { kind: 'app'; slug: string }
  | { kind: 'release'; slug: string; version: string }
  | { kind: 'collection-schema'; slug: string; collection: string; major: number }
  | { kind: 'document'; slug: string; collection: string; key: string }
  | { kind: 'runtime'; name: string; major: number };

// Slug, collection, version and runtime segments never contain `:`, `/` or `@`. A document key
// (the store's own key shape) may contain `:` but never `/` or `@`, and it is a document URN's
// last segment, so every URN still parses back unambiguously. Bounded like the store's own names.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const COLLECTION_RE = /^[a-z][a-z0-9_]{0,31}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;
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
