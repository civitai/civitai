/**
 * Source repos (`civitai-apps-src/<slug>`) — the PURE half: what a commit changes, what its
 * message says, and which files of an App Assistant export belong in it. No I/O here, so every
 * decision is a table test (`app-source-repo.plan.test.ts`). The I/O half is
 * `app-source-repo.service.ts`.
 */

import { createHash } from 'crypto';
import { platformUpdatePathShapeRefusal } from '@civitai/shared/platform-update-path';
import { MAX_FILES_IN_BUNDLE } from '~/server/schema/blocks/publish-request.schema';
import { forkSeedExclusionReason } from '~/server/services/blocks/fork-seed-exclusions';
import type { FileOperation } from '~/server/services/blocks/forgejo.service';
import { cliLeavesOut } from '~/shared/utils/app-bundle-paths';

/** A file as it goes into a commit: a repo-relative path and its bytes. */
export type SourceFile = { path: string; content: Buffer };

/** path → git blob sha: a tree as the contents API and `listRepoTree` describe it. */
export type BlobTree = Record<string, string>;

/** The branch every source repo is created with, and the one the developer pulls. */
export const SOURCE_MAIN_BRANCH = 'main';

/** The app's manifest, at the root of its source repo. */
export const MANIFEST_PATH = 'block.manifest.json';

/**
 * Where an App Assistant save goes when it cannot land on `main` without overwriting a change the
 * developer pushed (see `planAssistantCommit`). One fixed branch, so the assistant's side of a
 * conflict is one linear history the developer can merge.
 */
export const ASSISTANT_BRANCH = 'civitai-assistant';

/** Who an App Assistant commit is written by. The user it acts for is in the trailer. */
export const ASSISTANT_AUTHOR = {
  name: 'Civitai App Assistant',
  email: 'app-assistant@apps.civitai.invalid',
} as const;

/** Who a platform-written commit (a fork's seed, a backfill seed) is written by. */
export const PLATFORM_AUTHOR = {
  name: 'Civitai',
  email: 'platform@apps.civitai.invalid',
} as const;

/** A block slug (`blockId`), as the push webhook and the fork code accept one. */
export const SOURCE_SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

/** A lowercase SHA-1 or SHA-256 commit id. */
const COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isCommitSha(value: string): boolean {
  return COMMIT_SHA_RE.test(value);
}

/** The most bytes one source commit may carry (the fork seed's uncompressed cap). */
export const SOURCE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/**
 * Whether `path` is a file a source repo never holds: what the CLI's package leaves out
 * (`cliLeavesOut`) or a fork's seed leaves out (`forkSeedExclusionReason`). Matched as those two
 * lists match (mostly case-sensitive); {@link platformUpdatePathRefusal} also checks the
 * lowercased path.
 */
export function sourceRepoNeverHolds(path: string): boolean {
  return cliLeavesOut(path) || !!forkSeedExclusionReason(path);
}

/** git's blob id of `content`: sha1("blob <len>\0" + bytes). */
export function gitBlobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
}

export function treeOf(files: readonly SourceFile[]): BlobTree {
  const tree: BlobTree = {};
  for (const f of files) tree[f.path] = gitBlobSha(f.content);
  return tree;
}

/** A Map tree (as `listRepoTree` returns it) as a plain record. */
export function treeFromMap(map: ReadonlyMap<string, string>): BlobTree {
  return Object.fromEntries(map);
}

export class SourceFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceFilesError';
  }
}

/**
 * The files of an App Assistant export (a zip of the sandbox's app folder) that belong in the
 * app's source repo: the app folder's prefix (`<app>/`) taken off as Submit for review does, then
 * left out what the CLI's package leaves out (`cliLeavesOut`) and what a fork's seed leaves out
 * (`forkSeedExclusionReason`: git metadata, env files, keys, credential files, dependencies,
 * build output), so a credential the export let through is never committed.
 *
 * Throws {@link SourceFilesError} past {@link MAX_FILES_IN_BUNDLE} files or
 * {@link SOURCE_MAX_TOTAL_BYTES} bytes. Sorted by path.
 */
export function sourceFilesFromExport(
  entries: ReadonlyArray<{ path: string; content: Buffer }>,
  app: string
): SourceFile[] {
  const atRoot = entries.some((e) => e.path === 'block.manifest.json');
  const prefix = atRoot ? '' : `${app}/`;
  const out: SourceFile[] = [];
  let total = 0;
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix) || entry.path.endsWith('/')) continue;
    const rel = entry.path.slice(prefix.length).replace(/^\/+/, '');
    if (!rel || sourceRepoNeverHolds(rel)) continue;
    // A path git would refuse, or one that escapes the tree.
    if (rel.split('/').some((s) => s === '' || s === '.' || s === '..')) continue;
    total += entry.content.byteLength;
    if (total > SOURCE_MAX_TOTAL_BYTES)
      throw new SourceFilesError(`the app is larger than ${SOURCE_MAX_TOTAL_BYTES} bytes`);
    out.push({ path: rel, content: entry.content });
  }
  if (out.length > MAX_FILES_IN_BUNDLE)
    throw new SourceFilesError(`the app holds more than ${MAX_FILES_IN_BUNDLE} files`);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export type CommitPlan = {
  operations: FileOperation[];
  added: string[];
  updated: string[];
  deleted: string[];
};

/**
 * The commit that takes the assistant's files from `baseline` (the tree the platform last wrote
 * for the assistant) to `files`, touching ONLY what the assistant changed since.
 *
 * Every operation names the blob it expects to find (`sha`), or is a `create` of a path the
 * assistant has never written. Forgejo refuses the whole commit when the branch disagrees with
 * any of them, so:
 *   - a file only the developer changed is never in the plan, and their change stays;
 *   - a file both changed makes the commit refuse, and the save goes to {@link ASSISTANT_BRANCH}
 *     instead (`planReplaceCommit`), so neither side is lost.
 * Empty `operations` means the save changed nothing: no commit is written.
 */
export function planAssistantCommit(baseline: BlobTree, files: readonly SourceFile[]): CommitPlan {
  const plan: CommitPlan = { operations: [], added: [], updated: [], deleted: [] };
  const seen = new Set<string>();
  for (const file of files) {
    seen.add(file.path);
    const before = baseline[file.path];
    const sha = gitBlobSha(file.content);
    if (before === sha) continue;
    if (before === undefined) {
      plan.operations.push({ operation: 'create', path: file.path, content: file.content });
      plan.added.push(file.path);
    } else {
      plan.operations.push({
        operation: 'update',
        path: file.path,
        content: file.content,
        sha: before,
      });
      plan.updated.push(file.path);
    }
  }
  for (const [path, sha] of Object.entries(baseline).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (seen.has(path)) continue;
    plan.operations.push({ operation: 'delete', path, sha });
    plan.deleted.push(path);
  }
  return plan;
}

/**
 * The commit that makes a branch whose tree is `current` hold exactly `files`: what a seed commit
 * and a save onto {@link ASSISTANT_BRANCH} write. Each operation names the blob `current` holds,
 * so a branch that moved after `current` was read refuses rather than losing that move.
 */
export function planReplaceCommit(current: BlobTree, files: readonly SourceFile[]): CommitPlan {
  return planAssistantCommit(current, files);
}

/**
 * A trailer value we are willing to write: one line of printable ASCII without `:` runs that
 * could start another trailer, at most 200 characters. Anything else is OMITTED, never escaped.
 */
export function isTrailerSafe(value: string): boolean {
  return value.length > 0 && value.length <= 200 && /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(value);
}

function trailerBlock(trailers: ReadonlyArray<readonly [string, string | null | undefined]>) {
  const lines = trailers
    .filter((t): t is readonly [string, string] => typeof t[1] === 'string' && isTrailerSafe(t[1]))
    .map(([k, v]) => `${k}: ${v}`);
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}

function listed(paths: readonly string[], verb: string): string | null {
  if (!paths.length) return null;
  if (paths.length === 1) return `${verb} ${paths[0]}`;
  return `${verb} ${paths.length} files`;
}

/**
 * An App Assistant save's commit message: a one-line summary of what changed (derived from the
 * change itself, never from model or user text), and the user it was made for.
 *
 * 🔴 The trailer names the user by their platform git handle (`dev-<userId>`), resolved by the
 * server from the authenticated caller — never a value a client sent.
 */
export function assistantCommitMessage(plan: CommitPlan, onBehalfOf: string): string {
  const parts = [
    listed(plan.added, 'add'),
    listed(plan.updated, 'update'),
    listed(plan.deleted, 'delete'),
  ].filter((p): p is string => !!p);
  const summary = parts.length ? parts.join(', ') : 'no changes';
  const subject = `App Assistant: ${summary}`.slice(0, 100);
  return `${subject}${trailerBlock([
    ['Assisted-by', ASSISTANT_AUTHOR.name],
    ['On-behalf-of', onBehalfOf],
  ])}`;
}

export type ForkLineage = {
  /** The parent's slug, from the server's own fork session or `app_blocks` lineage. */
  parentSlug: string;
  /** The parent's approved commit the fork was seeded from. */
  parentCommitSha: string;
};

/**
 * The first commit of a fork's source repo. The `Forked-From-*` trailers come ONLY from `lineage`,
 * which the caller resolves on the server (the fork session, or `app_blocks.fork_of_*`); a value
 * that is not a slug or a commit id is left out rather than written.
 */
export function forkSeedCommitMessage(lineage: ForkLineage): string {
  const slug = SOURCE_SLUG_RE.test(lineage.parentSlug) ? lineage.parentSlug : null;
  const sha = COMMIT_SHA_RE.test(lineage.parentCommitSha) ? lineage.parentCommitSha : null;
  const subject = slug ? `Fork of ${slug}` : 'Fork';
  return `${subject}${trailerBlock([
    ['Forked-From-App', slug],
    ['Forked-From-Commit', sha],
  ])}`;
}

/**
 * The first commit of a source repo seeded from an app's latest approved version (the backfill).
 * A fork's lineage, when given, comes from `app_blocks.fork_of_*` (server-written) only.
 */
export function approvedSeedCommitMessage(args: {
  version: string | null;
  approvedCommitSha: string;
  lineage?: ForkLineage | null;
}): string {
  const version = args.version && isTrailerSafe(args.version) ? args.version : null;
  const sha = COMMIT_SHA_RE.test(args.approvedCommitSha) ? args.approvedCommitSha : null;
  const parentSlug =
    args.lineage && SOURCE_SLUG_RE.test(args.lineage.parentSlug) ? args.lineage.parentSlug : null;
  const parentSha =
    args.lineage && COMMIT_SHA_RE.test(args.lineage.parentCommitSha)
      ? args.lineage.parentCommitSha
      : null;
  return `Import ${version ? `v${version}` : 'the approved version'}${trailerBlock([
    ['Approved-Commit', sha],
    ['Forked-From-App', parentSlug],
    ['Forked-From-Commit', parentSha],
  ])}`;
}

/** Every platform update is committed to its own branch, named for the update's id. */
export const PLATFORM_UPDATE_BRANCH_PREFIX = 'platform-update/';

export function platformUpdateBranch(updateId: string): string {
  return `${PLATFORM_UPDATE_BRANCH_PREFIX}${updateId.toLowerCase()}`;
}

/** One change a moderator asks for: write `content` at `path`, or delete `path`. */
export type PlatformUpdateChange =
  | { operation: 'put'; path: string; content: Buffer }
  | { operation: 'delete'; path: string };

/**
 * Directory names the CLI's packager (`civitai/cli` `internal/pkgzip`, `excludedDirs`) drops at
 * EVERY depth: VCS metadata, dependency installs, build output and tooling caches. A platform
 * update under one of them could never reach a submitted bundle, so the submit check would refuse
 * every bundle of the app until staff withdrew it. Platform updates only: the shared source-repo
 * lists ({@link sourceRepoNeverHolds}) match build output at the top level alone.
 */
const CLI_PACKAGE_DROPPED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '.pnpm-store',
  'dist',
  'build',
  'out',
  '.next',
  '.vite',
  '.cache',
  'coverage',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.turbo',
]);

/**
 * Why `path` may not be written by a platform update, or `null` when it may: a path git would
 * refuse or that escapes the tree ({@link platformUpdatePathShapeRefusal}, shared with the
 * assistant runner), and anything a source repo never holds
 * ({@link sourceRepoNeverHolds}: env files, keys, credentials, dependencies, build output),
 * in ANY letter case (`.ENV`, `.Env.local`, `Node_Modules/…`): a checkout on a case-insensitive
 * file system reads those as the lowercase name. Also anything under a folder the CLI's package
 * drops at every depth ({@link CLI_PACKAGE_DROPPED_DIRS}: `src/build/…`, `packages/x/coverage/…`).
 * The shared lists themselves (fork seed, App Assistant export) are unchanged.
 */
export function platformUpdatePathRefusal(path: string): string | null {
  const shape = platformUpdatePathShapeRefusal(path);
  if (shape) return shape;
  if (sourceRepoNeverHolds(path) || sourceRepoNeverHolds(path.toLowerCase()))
    return 'is a file a source repo never holds';
  // Every directory on the path (not the file's own name), in any letter case.
  if (
    path
      .split('/')
      .slice(0, -1)
      .some((dir) => CLI_PACKAGE_DROPPED_DIRS.has(dir.toLowerCase()))
  )
    return "is in a folder the app's package always leaves out";
  return null;
}

export class PlatformUpdatePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformUpdatePlanError';
  }
}

/**
 * The commit that applies `changes` on top of a branch whose tree is `current`. Each operation
 * names the blob `current` holds, so a branch that moved after it was read refuses the commit.
 *
 * A `put` of the bytes already there is left out; a `delete` of a path `current` does not hold is
 * refused ({@link PlatformUpdatePlanError}), as is a path named twice or a refused path. Empty
 * `operations` means the update changes nothing.
 */
export function planPlatformUpdateCommit(
  current: BlobTree,
  changes: readonly PlatformUpdateChange[]
): CommitPlan {
  const plan: CommitPlan = { operations: [], added: [], updated: [], deleted: [] };
  const seen = new Set<string>();
  for (const change of changes) {
    const refusal = platformUpdatePathRefusal(change.path);
    if (refusal) throw new PlatformUpdatePlanError(`${change.path} ${refusal}`);
    if (seen.has(change.path))
      throw new PlatformUpdatePlanError(`${change.path} is named more than once`);
    seen.add(change.path);
    const before = current[change.path];
    if (change.operation === 'delete') {
      if (before === undefined)
        throw new PlatformUpdatePlanError(`${change.path} does not exist on ${SOURCE_MAIN_BRANCH}`);
      plan.operations.push({ operation: 'delete', path: change.path, sha: before });
      plan.deleted.push(change.path);
      continue;
    }
    if (before === gitBlobSha(change.content)) continue;
    if (before === undefined) {
      plan.operations.push({ operation: 'create', path: change.path, content: change.content });
      plan.added.push(change.path);
    } else {
      plan.operations.push({
        operation: 'update',
        path: change.path,
        content: change.content,
        sha: before,
      });
      plan.updated.push(change.path);
    }
  }
  return plan;
}

/** The longest reason the platform stores (the table's CHECK). */
export const PLATFORM_UPDATE_REASON_MAX = 2000;

/** A reason as stored: control characters other than newline and tab removed, trimmed. */
export function normalisePlatformUpdateReason(reason: string): string {
  // eslint-disable-next-line no-control-regex
  return reason
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim();
}

/** The reason as one trailer line: whitespace collapsed, at most 200 characters. */
function reasonTrailer(reason: string): string {
  const line = reason.replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/**
 * A platform update's commit message: a summary derived from the change, the moderator's reason
 * as the body, and the `Platform-Update*` trailers.
 *
 * 🔴 The trailers are for humans reading `git log`. They prove nothing — anyone with push access
 * can write the same lines — so no reader may treat them as proof the commit came from staff;
 * that answer comes only from the update's server record (`app_platform_updates`).
 */
export function platformUpdateCommitMessage(args: {
  plan: CommitPlan;
  updateId: string;
  byUsername: string | null;
  reason: string;
}): string {
  const parts = [
    listed(args.plan.added, 'add'),
    listed(args.plan.updated, 'update'),
    listed(args.plan.deleted, 'delete'),
  ].filter((p): p is string => !!p);
  const subject = `Platform update: ${parts.length ? parts.join(', ') : 'no changes'}`.slice(
    0,
    100
  );
  const body = normalisePlatformUpdateReason(args.reason);
  return `${subject}${body ? `\n\n${body}` : ''}${trailerBlock([
    ['Platform-Update', args.updateId],
    ['Platform-Update-By', args.byUsername],
    ['Reason', reasonTrailer(body)],
  ])}`;
}

/** The token-less HTTPS URL of a slug's source repo on the platform git host. */
export function sourceRepoHttpUrl(publicUrl: string, org: string, slug: string): string {
  const host = publicUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${host}/${org}/${slug}.git`;
}
