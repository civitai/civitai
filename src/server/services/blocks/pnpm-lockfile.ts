import yaml from 'js-yaml';

/**
 * Reading a `pnpm-lock.yaml`: shared by the outdated-SDK check (`sdk-floor.ts`) and the staff
 * platform-update check (`platform-update-containment.ts`).
 */

export type PnpmDepSets = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
};

export type PnpmLockDocument = PnpmDepSets & { importers?: Record<string, PnpmDepSets> };

/**
 * The project document of a pnpm lockfile. pnpm 11+ may write TWO documents: a leading boot
 * document (pnpm's own version and config dependencies, which also carries `importers["."]`) and
 * then the project lockfile. The project lockfile is always the last document, so that one is
 * returned. Throws when `body` is not YAML, or its last document is not a mapping.
 */
export function pnpmProjectDocument(body: string): PnpmLockDocument {
  const docs = yaml.loadAll(body);
  const lock = docs[docs.length - 1] ?? {};
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    throw new Error('not a lockfile object');
  }
  return lock as PnpmLockDocument;
}

/**
 * The version a direct-dependency entry resolves to: a bare string (v5) or `{ specifier, version }`
 * (v6+), with a peer suffix — `0.31.0(react@19.0.0)` or `0.31.0_react@19.0.0` — stripped. `null`
 * when the entry carries no version string.
 */
export function pnpmResolvedVersion(node: unknown): string | null {
  let v: unknown = node;
  if (node && typeof node === 'object') v = (node as { version?: unknown }).version;
  if (typeof v !== 'string') return null;
  const cut = v.search(/[(_]/);
  const clean = cut >= 0 ? v.slice(0, cut) : v;
  return clean || null;
}

const DEP_SETS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/**
 * Every direct dependency of every importer: importer (`.` for the root, and for a v5 lockfile's
 * top-level sets) → package name → resolved version ({@link pnpmResolvedVersion}). A package listed
 * in more than one set of an importer keeps the first (`dependencies`, then `devDependencies`, then
 * `optionalDependencies`). Throws when `body` is not a pnpm lockfile ({@link pnpmProjectDocument}),
 * or an entry has no version string (so the caller cannot tell what it resolves to).
 */
export function pnpmDirectDependencies(body: string): Map<string, Map<string, string>> {
  const lock = pnpmProjectDocument(body);
  const importers: Array<[string, unknown]> =
    lock.importers && typeof lock.importers === 'object'
      ? Object.entries(lock.importers)
      : [['.', lock]];
  const out = new Map<string, Map<string, string>>();
  for (const [importer, sets] of importers) {
    if (!sets || typeof sets !== 'object') throw new Error(`importer ${importer} is not a mapping`);
    const deps = new Map<string, string>();
    for (const set of DEP_SETS) {
      const entries = (sets as PnpmDepSets)[set];
      if (entries === undefined || entries === null) continue;
      if (typeof entries !== 'object' || Array.isArray(entries)) {
        throw new Error(`${importer} ${set} is not a mapping`);
      }
      for (const [name, node] of Object.entries(entries)) {
        if (deps.has(name)) continue;
        const version = pnpmResolvedVersion(node);
        if (version === null) throw new Error(`${importer} ${name} has no version`);
        deps.set(name, version);
      }
    }
    out.set(importer, deps);
  }
  return out;
}
