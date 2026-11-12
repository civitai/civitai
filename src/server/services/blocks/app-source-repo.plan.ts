/**
 * Source repos (`civitai-apps-src/<slug>`) — the PURE half: what a commit changes, what its
 * message says, and which files of an App Assistant export belong in it. No I/O here, so every
 * decision is a table test (`app-source-repo.plan.test.ts`). The I/O half is
 * `app-source-repo.service.ts`.
 */

import { createHash } from 'crypto';
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

/** The most bytes one source commit may carry (the fork seed's uncompressed cap). */
export const SOURCE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

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
    if (!rel || cliLeavesOut(rel) || forkSeedExclusionReason(rel)) continue;
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

/** The token-less HTTPS URL of a slug's source repo on the platform git host. */
export function sourceRepoHttpUrl(publicUrl: string, org: string, slug: string): string {
  const host = publicUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${host}/${org}/${slug}.git`;
}
