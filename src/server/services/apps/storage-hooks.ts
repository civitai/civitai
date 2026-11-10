/**
 * App Storage PERMISSION HOOKS — declaring and pinning (nothing in this module calls a hook).
 *
 * A collection's `hook: { file, sha256, timeoutMs? }` names one ES module of the bundle. Before a
 * version that declares one can be queued or approved, this module:
 *
 *   1. GATES the declaration, in two steps. While the `hooks` storage feature is off, every hook is
 *      refused "not available yet" (`not_available`). With it on, a hook that is NEW or CHANGED —
 *      its `(file, sha256)` differs from the same collection's hook in the app's approved manifest,
 *      or that manifest has none, or it cannot be read — needs the ACTOR who introduced this
 *      version (the submitter; on the git-push path the pusher) to be in the
 *      `app-blocks-storage-hooks` Flipt cohort, else it is refused `not_in_cohort`. A hook pinned
 *      exactly as approved skips the cohort (it was gated when it was introduced) but is pinned
 *      below like any other. Fail closed: an absent flag, Flipt down, an actor who does not resolve
 *      and an unreadable approved manifest all refuse a new or changed hook.
 *   2. PINS each file: its bytes, read from the bundle the version will ship (the submitted zip,
 *      the pushed commit, or at approve the stored bundle again), must exist (`missing`), be at
 *      most {@link APP_STORAGE_HOOK_MAX_BYTES} (`too_large`), be UTF-8 text with no NUL
 *      (`not_text`) and hash to the declared sha256 (`sha_mismatch`). At approve the request's
 *      stored file summary must also agree with the bytes (`summary_mismatch`), so a moderator
 *      never reviews a file list that differs from what ships.
 *   3. RECORDS each verified source in `app_storage_hook_sources`, keyed by its own sha256, so the
 *      runtime can load a hook by the sha the approved manifest pins and nothing else. The table is
 *      content-addressed and append-only: an existing row for a sha is the same bytes by
 *      definition, so the insert is `ON CONFLICT DO NOTHING`.
 *
 * Refusals are a {@link StorageHookRefusal} carrying the structured list; both submit routes return
 * it as `storageHookErrors` beside the message, as they return `storageBreakingChanges`.
 *
 * WHICH APP / VERSION / COLLECTION USES WHICH SHA is the approved manifest itself
 * (`app_blocks.manifest` → `storage.collections.<c>.hook.sha256`): no second mapping is kept that
 * could disagree with it.
 */

import { createHash } from 'crypto';
// Only pure imports at the top: the submit routes load this module for `isStorageHookRefusal`
// alone. The session client, Flipt, the feature-flag context and the db are loaded where used.
import {
  APP_STORAGE_ALL_FEATURES_ON,
  APP_STORAGE_ENABLED_FEATURES,
  APP_STORAGE_HOOK_MAX_BYTES,
  isStorageHookFileUnderOutputDir,
  parseManifestStorage,
  type DeclaredStorageHook,
} from '~/shared/constants/block-storage.constants';
import type { SessionUser } from '~/types/session';

export const STORAGE_HOOK_PROBLEM_REASONS = [
  'not_available',
  'not_in_cohort',
  'invalid',
  'under_output_dir',
  'missing',
  'too_large',
  'not_text',
  'sha_mismatch',
  'summary_mismatch',
] as const;
export type StorageHookProblemReason = (typeof STORAGE_HOOK_PROBLEM_REASONS)[number];

/** One refused hook. `expected` / `actual` are sha256 digests (or byte counts for `too_large`). */
export type StorageHookProblem = {
  collection: string;
  /** The declared file, or null when the declaration has none that parses. */
  file: string | null;
  reason: StorageHookProblemReason;
  expected?: string;
  actual?: string;
};

/** A file of the bundle, as `extractBundleMetadata` summarises it. */
export type StorageHookFileMeta = { path: string; sha256: string; sizeBytes: number };

const MAX_LISTED = 20;

function describeProblem(p: StorageHookProblem): string {
  const at = `storage.collections.${p.collection}.hook`;
  const file = p.file === null ? '' : ` ${JSON.stringify(p.file)}`;
  switch (p.reason) {
    case 'not_available':
      return `${at} is not available yet — permission hooks arrive in a later phase of App Storage; remove hook (the collection schema still applies)`;
    case 'not_in_cohort':
      return `${at} is new or changed since the approved version, and adding or changing a permission hook is not enabled for this account yet — permission hooks are in a limited rollout; keep the approved hook or remove hook (the collection schema still applies)`;
    case 'invalid':
      return `${at} is not a valid hook declaration`;
    case 'under_output_dir':
      return `${at}.file${file} is inside the build output (outputDir) — a hook must be a committed source file of the bundle, shipped verbatim`;
    case 'missing':
      return `${at}.file${file} is not in the bundle`;
    case 'too_large':
      return `${at}.file${file} is ${p.actual} bytes — a hook may be at most ${p.expected} bytes`;
    case 'not_text':
      return `${at}.file${file} is not UTF-8 text without NUL bytes — a hook is one JavaScript module`;
    case 'sha_mismatch':
      return `${at}.sha256 is ${p.expected}, but the bundle's${file} hashes to ${p.actual} — update sha256 to the file you ship`;
    case 'summary_mismatch':
      return `${at}.file${file} in the reviewed file list (${p.expected}) is not the file in the bundle (${p.actual})`;
  }
}

/** The submit / push / approve refusal. `problems` is what the submit routes return. */
export class StorageHookRefusal extends Error {
  readonly problems: StorageHookProblem[];
  constructor(problems: StorageHookProblem[], details: readonly string[] = []) {
    const listed = problems.slice(0, MAX_LISTED).map(describeProblem);
    if (problems.length > MAX_LISTED) listed.push(`…and ${problems.length - MAX_LISTED} more`);
    super(['storage hooks:', [...listed, ...details.slice(0, MAX_LISTED)].join('; ')].join(' '));
    this.name = 'StorageHookRefusal';
    this.problems = problems;
  }
}

export function isStorageHookRefusal(err: unknown): err is StorageHookRefusal {
  return err instanceof StorageHookRefusal;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The collections whose RAW declaration has a `hook` key, valid or not, in manifest order. Read
 * from the raw manifest on purpose: a malformed hook is still a hook declaration, and must be
 * refused "not available" while the gate is closed rather than slip through as a shape error.
 */
export function declaredStorageHookCollections(
  manifest: unknown
): { collection: string; raw: unknown }[] {
  if (!isObj(manifest) || !isObj(manifest.storage)) return [];
  const collections = manifest.storage.collections;
  if (!isObj(collections)) return [];
  const out: { collection: string; raw: unknown }[] = [];
  for (const [collection, decl] of Object.entries(collections)) {
    if (isObj(decl) && Object.hasOwn(decl, 'hook')) out.push({ collection, raw: decl.hook });
  }
  return out;
}

export function declaresStorageHooks(manifest: unknown): boolean {
  return declaredStorageHookCollections(manifest).length > 0;
}

/**
 * Whether this actor may introduce a new or changed permission hook: they are in the
 * `app-blocks-storage-hooks` cohort (per-user eval, the same entityId and context as the other
 * author gates). Every failure — no actor (`null`: the pusher did not resolve), the actor not
 * resolving, Flipt down or throwing, the flag absent — answers false. The `hooks` feature switch is
 * checked by the caller first.
 */
export async function isInStorageHookCohort(userId: number | null | undefined): Promise<boolean> {
  if (typeof userId !== 'number') return false;
  const [{ sessionClient }, { FLIPT_FEATURE_FLAGS, isFlipt }, { buildFliptContext }] =
    await Promise.all([
      import('~/server/auth/session-client'),
      import('~/server/flipt/client'),
      import('~/server/services/feature-flags.service'),
    ]);
  let user: SessionUser | null;
  try {
    user = (await sessionClient.getSessionUserById(userId)) as SessionUser | null;
  } catch {
    return false;
  }
  if (!user) return false;
  try {
    return (
      (await isFlipt(
        FLIPT_FEATURE_FLAGS.APP_BLOCKS_STORAGE_HOOKS,
        String(user.id),
        buildFliptContext(user)
      )) === true
    );
  } catch {
    return false;
  }
}

/**
 * The `(file, sha256)` each collection's hook is pinned to in the app's approved manifest, as
 * strings straight from its raw declaration (the parser does not normalise either). Fails closed:
 * a manifest that cannot be read, or has no hooks, is an empty map, so every hook counts as new.
 */
async function readApprovedHookPins(
  readApprovedManifest: () => Promise<unknown>
): Promise<Map<string, { file: string; sha256: string }>> {
  const pins = new Map<string, { file: string; sha256: string }>();
  let approved: unknown;
  try {
    approved = await readApprovedManifest();
  } catch {
    return pins;
  }
  for (const { collection, raw } of declaredStorageHookCollections(approved)) {
    if (isObj(raw) && typeof raw.file === 'string' && typeof raw.sha256 === 'string')
      pins.set(collection, { file: raw.file, sha256: raw.sha256 });
  }
  return pins;
}

type ResolvedHooks =
  | { kind: 'hooks'; hooks: Map<string, DeclaredStorageHook> }
  | { kind: 'invalid'; problems: StorageHookProblem[]; details: string[] }
  /** `storage` has errors that are not about a hook: the manifest validator reports them. */
  | { kind: 'unparsed' };

/** The declared hooks, by collection, read for their SHAPE (every phased feature on). */
function resolveDeclaredHooks(
  manifest: unknown,
  declared: { collection: string; raw: unknown }[]
): ResolvedHooks {
  const parsed = parseManifestStorage(manifest, APP_STORAGE_ALL_FEATURES_ON);
  if (parsed.errors.length === 0) {
    const hooks = new Map<string, DeclaredStorageHook>();
    for (const [name, collection] of parsed.collections) {
      if (collection.hook) hooks.set(name, collection.hook);
    }
    return { kind: 'hooks', hooks };
  }
  const outputDir = isObj(manifest) ? manifest.outputDir : undefined;
  const problems: StorageHookProblem[] = [];
  const details: string[] = [];
  for (const { collection, raw } of declared) {
    const prefix = `storage.collections.${collection}.hook`;
    const mine = parsed.errors.filter((e) => e.startsWith(prefix));
    if (mine.length === 0) continue;
    const file = isObj(raw) && typeof raw.file === 'string' ? raw.file : null;
    problems.push({
      collection,
      file,
      reason:
        file !== null && isStorageHookFileUnderOutputDir(file, outputDir)
          ? 'under_output_dir'
          : 'invalid',
    });
    details.push(...mine);
  }
  return problems.length > 0 ? { kind: 'invalid', problems, details } : { kind: 'unparsed' };
}

// `ignoreBOM`: keep a leading BOM in the text, so the recorded source re-encodes to the exact bytes
// the sha256 was taken over (the default decoder strips it).
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function asHookSource(bytes: Buffer): string | null {
  try {
    const text = UTF8.decode(bytes);
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}

export type VerifiedStorageHookSource = { sha256: string; source: string; sizeBytes: number };

/**
 * Checks every declared hook against the bytes of its file. Pure. `contents` maps a bundle path to
 * its bytes (a path absent from it is missing from the bundle). Returns the problems and, for the
 * files that verified, their sources by sha256.
 */
export function verifyStorageHookFiles(
  hooks: ReadonlyMap<string, DeclaredStorageHook>,
  contents: ReadonlyMap<string, Buffer>
): { problems: StorageHookProblem[]; sources: Map<string, VerifiedStorageHookSource> } {
  const problems: StorageHookProblem[] = [];
  const sources = new Map<string, VerifiedStorageHookSource>();
  for (const [collection, hook] of hooks) {
    const bytes = contents.get(hook.file);
    const base = { collection, file: hook.file };
    if (!bytes) {
      problems.push({ ...base, reason: 'missing' });
      continue;
    }
    if (bytes.length > APP_STORAGE_HOOK_MAX_BYTES) {
      problems.push({
        ...base,
        reason: 'too_large',
        expected: String(APP_STORAGE_HOOK_MAX_BYTES),
        actual: String(bytes.length),
      });
      continue;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== hook.sha256) {
      problems.push({ ...base, reason: 'sha_mismatch', expected: hook.sha256, actual });
      continue;
    }
    const source = asHookSource(bytes);
    if (source === null) {
      problems.push({ ...base, reason: 'not_text' });
      continue;
    }
    sources.set(actual, { sha256: actual, source, sizeBytes: bytes.length });
  }
  return { problems, sources };
}

/**
 * Approve's cross-check: the reviewed file list must describe each hook file exactly as the bundle
 * does. A file the list does not name is not a mismatch (a push-originated request's list may not
 * have been filled in yet) — the bytes check already decides whether the file ships.
 */
export function checkStorageHookFileSummary(
  hooks: ReadonlyMap<string, DeclaredStorageHook>,
  contents: ReadonlyMap<string, Buffer>,
  files: readonly StorageHookFileMeta[]
): StorageHookProblem[] {
  const listed = new Map(files.map((f) => [f.path, f.sha256]));
  const problems: StorageHookProblem[] = [];
  for (const [collection, hook] of hooks) {
    const expected = listed.get(hook.file);
    const bytes = contents.get(hook.file);
    if (expected === undefined || !bytes) continue;
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (expected !== actual) {
      problems.push({ collection, file: hook.file, reason: 'summary_mismatch', expected, actual });
    }
  }
  return problems;
}

type RawClient = {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

/** The hand-applied hook-source table is absent. `app-access.service` is loaded lazily, as elsewhere. */
async function isSourcesTableMissing(err: unknown): Promise<boolean> {
  const { isMissingTableError } = await import('~/server/services/blocks/app-access.service');
  return isMissingTableError(err);
}

export const HOOK_SOURCES_TABLE_MISSING =
  'storage hooks: the app_storage_hook_sources table does not exist yet, so the hook source cannot be recorded — apply migration 20261224120000_app_storage_hook_sources, then submit again';

/**
 * Records verified hook sources, all in ONE statement. Idempotent: a sha already recorded is the
 * same bytes. Throws {@link HOOK_SOURCES_TABLE_MISSING} when the hand-applied migration has not run,
 * so a version is never queued with a hook the runtime could not load.
 */
export async function recordStorageHookSources(
  sources: ReadonlyMap<string, VerifiedStorageHookSource>
): Promise<void> {
  if (sources.size === 0) return;
  const list = [...sources.values()];
  const shas = list.map((s) => s.sha256);
  const texts = list.map((s) => s.source);
  const sizes = list.map((s) => s.sizeBytes);
  const { dbWrite } = await import('~/server/db/client');
  try {
    await (dbWrite as unknown as RawClient).$executeRaw`
      INSERT INTO "app_storage_hook_sources" ("sha256", "source", "size_bytes")
      SELECT s.sha256, s.source, s.size_bytes
      FROM unnest(${shas}::text[], ${texts}::text[], ${sizes}::int[]) AS s(sha256, source, size_bytes)
      ON CONFLICT ("sha256") DO NOTHING
    `;
  } catch (err) {
    if (await isSourcesTableMissing(err)) throw new Error(HOOK_SOURCES_TABLE_MISSING);
    throw err;
  }
}

/**
 * THE check, shared by submit, the git-push path and approve. A no-op for a manifest that declares
 * no hook (neither reader is called). Otherwise gates the declaration (the feature switch, then,
 * for each hook new or changed against `readApprovedManifest`, the cohort of `actorUserId`), reads
 * the hook files through `readFiles`, verifies every one of them (and, at approve, the reviewed
 * file list), and records their sources. Throws {@link StorageHookRefusal} on any problem, before
 * recording.
 *
 * A manifest whose `storage` has errors that are NOT about a hook is left to the manifest
 * validator (approve and the push path run it before this; submit defers it to approve).
 */
export async function pinStorageHooks(args: {
  manifest: unknown;
  /**
   * The actor who introduced this version: the submitter at submit and approve, the pusher on the
   * git-push path. `null` / `undefined` (a pusher that maps to no user) fails a new or changed hook.
   */
  actorUserId: number | null | undefined;
  /** The app's approved manifest (null for an app with none). A throw counts every hook as new. */
  readApprovedManifest: () => Promise<unknown>;
  readFiles: (paths: string[]) => Promise<ReadonlyMap<string, Buffer>>;
  fileSummary?: readonly StorageHookFileMeta[];
}): Promise<{ pinned: number }> {
  const declared = declaredStorageHookCollections(args.manifest);
  if (declared.length === 0) return { pinned: 0 };

  const refuseAll = (
    hooks: { collection: string; raw: unknown }[],
    reason: 'not_available' | 'not_in_cohort'
  ) =>
    new StorageHookRefusal(
      hooks.map(({ collection, raw }) => ({
        collection,
        file: isObj(raw) && typeof raw.file === 'string' ? raw.file : null,
        reason,
      }))
    );

  if (!APP_STORAGE_ENABLED_FEATURES.hooks) throw refuseAll(declared, 'not_available');

  // Only a hook the approved version does not already pin identically needs the cohort.
  const approvedPins = await readApprovedHookPins(args.readApprovedManifest);
  const introduced = declared.filter(({ collection, raw }) => {
    const pin = approvedPins.get(collection);
    return !(pin && isObj(raw) && raw.file === pin.file && raw.sha256 === pin.sha256);
  });
  if (introduced.length > 0 && !(await isInStorageHookCohort(args.actorUserId))) {
    throw refuseAll(introduced, 'not_in_cohort');
  }

  const resolved = resolveDeclaredHooks(args.manifest, declared);
  if (resolved.kind === 'invalid')
    throw new StorageHookRefusal(resolved.problems, resolved.details);
  if (resolved.kind === 'unparsed') return { pinned: 0 };

  const paths = [...new Set([...resolved.hooks.values()].map((h) => h.file))];
  const contents = await args.readFiles(paths);
  const { problems, sources } = verifyStorageHookFiles(resolved.hooks, contents);
  if (args.fileSummary) {
    problems.push(...checkStorageHookFileSummary(resolved.hooks, contents, args.fileSummary));
  }
  if (problems.length > 0) throw new StorageHookRefusal(problems);

  await recordStorageHookSources(sources);
  return { pinned: resolved.hooks.size };
}
