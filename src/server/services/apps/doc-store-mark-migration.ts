// THE MARK MIGRATION's pure rules (`docs/app-storage-generic-core.md`, "Data migration"): which
// parent each source key becomes, whether a source's keys fit, and whether a target holds
// exactly what its source marks say. No SQL and no I/O: the store (`doc-store.ts`, the only code
// that touches the `appdata` tables) reads the rows and calls these, so the key check, the copy
// and the verify apply ONE mapping.
import {
  DOC_STORE_BOUNDS,
  DocStoreError,
  isViewerKeyParent,
} from '~/server/services/apps/doc-store.types';

/** A deterministic table from source document key to parent, given by the person running it. */
export type MarkKeyMap = Readonly<Record<string, string>>;

/** What a mark migration was started with, stored on its run and compared on every re-run. */
export type MarkMigrationParams = {
  /** The viewer-keyed (`parent+viewer`) target collection. */
  to: string;
  /** The constant body every copied document gets (`{}` for a plain vote). */
  data: Record<string, unknown>;
  /** Source key → parent, for the source keys that do not fit the parent grammar as they are. */
  keyMap: MarkKeyMap | null;
};

/** Mark rows one migration reads at most; a larger source is refused before anything is written. */
export const MARK_MIGRATION_MAX_ROWS = 50_000;
/** Entries a key map may hold. */
export const MARK_KEY_MAP_MAX = 10_000;
/** Keys sampled into a check's or a verify's report (the counts are always exact). */
export const MARK_MIGRATION_SAMPLES = 20;

const invalid = (message: string, details?: Record<string, unknown>) =>
  new DocStoreError('invalid_request', message, details);

/**
 * The key map, validated: a plain object of at most {@link MARK_KEY_MAP_MAX} entries whose keys
 * are store keys and whose values are strings (a value outside the parent grammar is reported by
 * the key check, never silently used). Null or undefined: no map.
 */
export function assertMarkKeyMap(raw: unknown): MarkKeyMap | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('keyMap must be an object');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MARK_KEY_MAP_MAX) {
    throw invalid(`keyMap may hold at most ${MARK_KEY_MAP_MAX} entries`);
  }
  const out: Record<string, string> = {};
  for (const [from, to] of entries) {
    if (!DOC_STORE_BOUNDS.key.test(from))
      throw invalid('keyMap names a key outside the key grammar');
    if (typeof to !== 'string') throw invalid('keyMap values must be strings');
    out[from] = to;
  }
  return out;
}

/** The parent a source key becomes: its mapped parent when the map names it, else the key. */
export function parentOf(key: string, keyMap: MarkKeyMap | null): string {
  return keyMap !== null && Object.prototype.hasOwnProperty.call(keyMap, key) ? keyMap[key] : key;
}

/** The outcome of the key check (step 1). `ok` false refuses the whole target. */
export type MarkKeyCheck = {
  ok: boolean;
  /** Mark rows of (collection, mark). */
  rows: number;
  /** Distinct source keys and distinct voters. */
  keys: number;
  users: number;
  /** Source keys whose parent (mapped or not) does not fit the parent grammar. */
  unfit: number;
  unfitSample: string[];
  /** Source keys that took their parent from the map. */
  mapped: number;
  /** Parents more than one source key maps to: two marks of one voter would derive one key. */
  collisions: number;
  collisionSample: string[];
  /** Map entries that name no source key (harmless; reported so a typo is visible). */
  unusedMapKeys: number;
};

/** Step 1, the key check, over the distinct source keys (each with its row count). */
export function checkMarkKeys(args: {
  keys: readonly { key: string; rows: number }[];
  users: number;
  keyMap: MarkKeyMap | null;
}): MarkKeyCheck {
  const { keyMap } = args;
  const unfit: string[] = [];
  const byParent = new Map<string, string[]>();
  let mapped = 0;
  let rows = 0;
  for (const { key, rows: n } of args.keys) {
    rows += n;
    const parent = parentOf(key, keyMap);
    if (parent !== key) mapped += 1;
    if (!isViewerKeyParent(parent)) unfit.push(key);
    const sources = byParent.get(parent) ?? [];
    sources.push(key);
    byParent.set(parent, sources);
  }
  const collisions = [...byParent].filter(([, sources]) => sources.length > 1).map(([p]) => p);
  const sourceKeys = new Set(args.keys.map((k) => k.key));
  const unusedMapKeys = keyMap ? Object.keys(keyMap).filter((k) => !sourceKeys.has(k)).length : 0;
  return {
    ok: unfit.length === 0 && collisions.length === 0,
    rows,
    keys: args.keys.length,
    users: args.users,
    unfit: unfit.length,
    unfitSample: unfit.slice(0, MARK_MIGRATION_SAMPLES),
    mapped,
    collisions: collisions.length,
    collisionSample: collisions.slice(0, MARK_MIGRATION_SAMPLES),
    unusedMapKeys,
  };
}

/** Whether two runs' parameters are the same run (a re-run), compared by canonical JSON. */
export function sameMarkMigrationParams(a: MarkMigrationParams, b: MarkMigrationParams): boolean {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, canon((v as Record<string, unknown>)[k])])
      );
    }
    return v;
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** One count that differs between the source marks and the target documents. */
export type CountMismatch = { id: string; expected: number; actual: number };

/** Step 4, the verify: what the target holds against what its source marks say. */
export type MarkMigrationVerify = {
  ok: boolean;
  sourceRows: number;
  targetDocs: number;
  /** Parents whose source mark count differs from their target document count. */
  parentMismatches: number;
  parentSample: CountMismatch[];
  /** Voters whose source mark count differs from the documents they author in the target. */
  userMismatches: number;
  userSample: CountMismatch[];
  /** Derived keys a source mark needs that the target lacks, and target keys no mark derives. */
  missing: number;
  missingSample: string[];
  extra: number;
  extraSample: string[];
  /** Target documents that are not user-authored shared documents (none may exist). */
  foreign: number;
};

/**
 * Compare the source mark rows with the target's documents, by counting both sides per parent and
 * per user, and by the exact derived key. A parent is a target key's text before its first `:` (a
 * parent has no `:`); a key with none counts under the empty parent, which no source has.
 */
export function compareMarkMigration(args: {
  source: readonly { key: string; userId: number }[];
  target: readonly {
    key: string;
    scopeUid: number;
    authorUid: number | null;
    authorKind: string;
  }[];
  keyMap: MarkKeyMap | null;
  deriveKey: (parent: string, viewerUid: number) => string;
}): MarkMigrationVerify {
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const wantParent = new Map<string, number>();
  const wantUser = new Map<string, number>();
  const wantKeys = new Set<string>();
  for (const { key, userId } of args.source) {
    const parent = parentOf(key, args.keyMap);
    bump(wantParent, parent);
    bump(wantUser, String(userId));
    wantKeys.add(args.deriveKey(parent, userId));
  }
  const haveParent = new Map<string, number>();
  const haveUser = new Map<string, number>();
  const haveKeys = new Set<string>();
  let foreign = 0;
  for (const d of args.target) {
    const sep = d.key.indexOf(':');
    bump(haveParent, sep < 0 ? '' : d.key.slice(0, sep));
    bump(haveUser, d.authorUid === null ? 'none' : String(d.authorUid));
    haveKeys.add(d.key);
    if (d.scopeUid !== 0 || d.authorKind !== 'user') foreign += 1;
  }
  const diff = (want: Map<string, number>, have: Map<string, number>): CountMismatch[] =>
    [...new Set([...want.keys(), ...have.keys()])]
      .sort()
      .map((id) => ({ id, expected: want.get(id) ?? 0, actual: have.get(id) ?? 0 }))
      .filter((m) => m.expected !== m.actual);
  const parents = diff(wantParent, haveParent);
  const users = diff(wantUser, haveUser);
  const missing = [...wantKeys].filter((k) => !haveKeys.has(k)).sort();
  const extra = [...haveKeys].filter((k) => !wantKeys.has(k)).sort();
  return {
    ok: foreign === 0,
    sourceRows: args.source.length,
    targetDocs: args.target.length,
    parentMismatches: parents.length,
    parentSample: parents.slice(0, MARK_MIGRATION_SAMPLES),
    userMismatches: users.length,
    userSample: users.slice(0, MARK_MIGRATION_SAMPLES),
    missing: missing.length,
    missingSample: missing.slice(0, MARK_MIGRATION_SAMPLES),
    extra: extra.length,
    extraSample: extra.slice(0, MARK_MIGRATION_SAMPLES),
    foreign,
  };
}
