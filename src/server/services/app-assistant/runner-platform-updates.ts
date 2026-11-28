import { TRPCError } from '@trpc/server';
import { isCommitSha, SOURCE_SLUG_RE } from '~/server/services/blocks/app-source-repo.plan';
import type { AssistantSaveResult } from '~/server/services/blocks/app-source-repo.service';
import {
  missingUpdatePaths,
  utf8TextOf,
} from '~/server/services/blocks/platform-update-containment';
import type { SessionUser } from '~/types/session';

/**
 * STAFF PLATFORM UPDATES for App Assistant's server runner: the OPEN updates of the open app, with
 * the files each one changes, and the report of what the runner did with one, for the user the run
 * grant names, through the owner API of `app-platform-update.service.ts`. How the runner applies
 * them: `apps/assistant-runner/src/app-assistant/platform-updates.ts`. The answers are here, without
 * I/O (`RunnerPlatformUpdateDeps`); the routes are `runner-platform-updates-route.ts`.
 *
 *   POST platform-updates           `{ grant, app }` → `{ updates: RunnerPlatformUpdate[] }`
 *   POST platform-updates/resolve   `{ grant, app, id, commitSha, outcome }` → `ResolveAnswer`
 *
 * Off (the flag, Apps for the user, an app with no block, or not theirs): the list answers
 * `{ updates: [] }`. The flag is read first, so with it off nothing else is asked or refused.
 *
 * `merged` refuses an update that is no longer verified BEFORE anything is saved. Otherwise it
 * saves the app from the sandbox and reports the commit that save wrote on `main` as the merge
 * commit, once that commit's tree holds the update ({@link missingPaths}). A save that went to the
 * assistant's side branch is not on `main`, so the update is reported `conflicted`.
 */

/**
 * The most bytes of file content (both sides of every file) ONE list answer carries, summed over
 * all its updates. An update that does not fit in what is left is listed with `tooLarge: true` and
 * no files, for the owner to merge with the CLI; the updates after it are still read.
 */
export const RUNNER_PLATFORM_UPDATES_MAX_BYTES = 8 * 1024 * 1024;

const SOURCE_MAIN_BRANCH = 'main';
const OPEN_STATUSES = new Set(['pending', 'conflicted']);

export type RunnerPlatformUpdateFile = {
  path: string;
  operation: 'create' | 'update' | 'delete';
  /** The file at `baseCommitSha` (UTF-8), `null` when it was not there. */
  base: string | null;
  /** The file at `commitSha` (UTF-8), `null` when the update deletes it. */
  update: string | null;
  /** Either side is not UTF-8 text: the runner cannot write it into the sandbox. */
  binary?: true;
};

export type RunnerPlatformUpdate = {
  id: string;
  commitSha: string;
  baseCommitSha: string;
  reason: string;
  touchesManifest: boolean;
  status: 'pending' | 'conflicted';
  by: { username: string | null };
  /** `verifyCommit`'s verdict: the only source of the "verified Civitai staff" line. */
  verified: boolean;
  /** The record's paths (also when `files` is empty). */
  paths: Array<{ path: string; operation: 'create' | 'update' | 'delete' }>;
  /** Empty when not `verified` (its content is never read) or `tooLarge`. */
  files: RunnerPlatformUpdateFile[];
  /** It did not fit in {@link RUNNER_PLATFORM_UPDATES_MAX_BYTES}: merge it with the CLI. */
  tooLarge?: true;
};

/** The owner-facing record, as `app-platform-update.service.ts` returns it (fields used here). */
export type OwnerUpdate = {
  id: string;
  commitSha: string;
  baseCommitSha: string;
  reason: string;
  paths: Array<{ path: string; operation: 'create' | 'update' | 'delete' }>;
  touchesManifest: boolean;
  status: string;
  by: { username: string | null; verifiedStaff: boolean };
};

export type RunnerPlatformUpdateDeps = {
  /** The `app-blocks-platform-updates` flag (global). Read before anything else. */
  flagOn: () => Promise<boolean>;
  user: (
    userId: number
  ) => Promise<
    | { refusal: { status: number; error: string; code: string }; user?: undefined }
    | { refusal: null; user: SessionUser }
  >;
  /** Apps for the user. */
  appsEnabled: (user: SessionUser) => Promise<boolean>;
  /** The app's open updates (`pending` and `conflicted`), oldest first. */
  listOpen: (args: { userId: number; slug: string }) => Promise<OwnerUpdate[]>;
  verifyCommit: (args: {
    userId: number;
    slug: string;
    commitSha: string;
  }) => Promise<{ verified: boolean; update: OwnerUpdate | null }>;
  resolve: (args: {
    userId: number;
    id: string;
    outcome: 'merged' | 'conflicted';
    mergeCommitSha?: string | null;
  }) => Promise<unknown>;
  /** path → blob sha of the source repo at a COMMIT id. */
  treeAt: (slug: string, commitSha: string) => Promise<Map<string, string>>;
  blob: (slug: string, blobSha: string) => Promise<Buffer>;
  save: (args: { userId: number; app: string }) => Promise<AssistantSaveResult>;
  /** The source repo's record of the assistant's last save. */
  lastSave: (slug: string) => Promise<{ sha: string | null; branch: string | null } | null>;
};

export type Answer = { status: number; json: unknown };

const NO_UPDATES: Answer = { status: 200, json: { updates: [] } };
const NOT_FOUND: Answer = {
  status: 404,
  json: { error: 'No update of yours under that id', code: 'NOT_FOUND' },
};
const DISABLED: Answer = {
  status: 404,
  json: { error: 'Platform updates are not enabled', code: 'disabled' },
};

async function gate(
  userId: number,
  deps: RunnerPlatformUpdateDeps
): Promise<{ answer: Answer; off?: true } | { ok: true }> {
  // The flag first: with it off nothing is refused, so a runner asking at every reply hears nothing.
  if (!(await deps.flagOn())) return { answer: NO_UPDATES, off: true };
  const subject = await deps.user(userId);
  if (subject.refusal)
    return {
      answer: {
        status: subject.refusal.status,
        json: { error: subject.refusal.error, code: subject.refusal.code },
      },
    };
  if (!(await deps.appsEnabled(subject.user))) return { answer: NO_UPDATES, off: true };
  return { ok: true };
}

/** A NOT_FOUND from the owner gate (no such app, not theirs): no updates, and no oracle. */
function isNotFound(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'NOT_FOUND';
}

/** The update's files at its two recorded commits, or `null` once they pass `budget` bytes. */
async function readFiles(
  app: string,
  update: OwnerUpdate,
  budget: number,
  deps: RunnerPlatformUpdateDeps
): Promise<{ files: RunnerPlatformUpdateFile[]; bytes: number } | null> {
  const [base, target] = await Promise.all([
    deps.treeAt(app, update.baseCommitSha),
    deps.treeAt(app, update.commitSha),
  ]);
  let bytes = 0;
  const read = async (blobSha: string | undefined) => {
    if (!blobSha) return { text: null, binary: false };
    const content = await deps.blob(app, blobSha);
    bytes += content.byteLength;
    const text = utf8TextOf(content);
    return { text, binary: text === null };
  };
  const files: RunnerPlatformUpdateFile[] = [];
  // The record's paths, never a diff of the branch: exactly what the staff commit changes.
  for (const { path, operation } of update.paths) {
    const was = await read(base.get(path));
    if (bytes > budget) return null;
    const now = await read(target.get(path));
    if (bytes > budget) return null;
    files.push({
      path,
      operation,
      base: was.text,
      update: now.text,
      ...(was.binary || now.binary ? { binary: true as const } : {}),
    });
  }
  return { files, bytes };
}

/** The app's open updates, oldest first, each with its files at its two recorded commits. */
export async function answerPlatformUpdates(
  userId: number,
  app: string,
  deps: RunnerPlatformUpdateDeps
): Promise<Answer> {
  if (!SOURCE_SLUG_RE.test(app)) return NO_UPDATES;
  const admitted = await gate(userId, deps);
  if ('answer' in admitted) return admitted.answer;
  let open: OwnerUpdate[];
  try {
    open = await deps.listOpen({ userId, slug: app });
  } catch (err) {
    if (isNotFound(err)) return NO_UPDATES;
    throw err;
  }
  let budget = RUNNER_PLATFORM_UPDATES_MAX_BYTES;
  const updates: RunnerPlatformUpdate[] = [];
  for (const update of open) {
    if (!OPEN_STATUSES.has(update.status)) continue;
    if (!isCommitSha(update.commitSha) || !isCommitSha(update.baseCommitSha)) continue;
    const { verified } = await deps.verifyCommit({
      userId,
      slug: app,
      commitSha: update.commitSha,
    });
    const head: RunnerPlatformUpdate = {
      id: update.id,
      commitSha: update.commitSha,
      baseCommitSha: update.baseCommitSha,
      reason: update.reason,
      touchesManifest: update.touchesManifest === true,
      status: update.status as 'pending' | 'conflicted',
      by: { username: update.by.username ?? null },
      verified: verified === true,
      paths: update.paths.map(({ path, operation }) => ({ path, operation })),
      files: [],
    };
    // An update that is not verified is never applied: its content is not read.
    if (!head.verified) {
      updates.push(head);
      continue;
    }
    const read = await readFiles(app, update, budget, deps);
    if (!read) {
      updates.push({ ...head, tooLarge: true });
      continue;
    }
    budget -= read.bytes;
    updates.push({ ...head, files: read.files });
  }
  return { status: 200, json: { updates } };
}

export type ResolveAnswer =
  | { resolved: true; outcome: 'merged'; mergeCommitSha: string }
  | { resolved: true; outcome: 'conflicted' }
  /** Withdrawn by staff, or its author is not staff now: nothing saved, nothing recorded. */
  | { resolved: false; reason: 'withdrawn' }
  /** Saved, but these paths of the update do not hold its change on `main`: not recorded. */
  | { resolved: false; reason: 'incomplete'; paths: string[] }
  | { resolved: false; reason: string };

/**
 * The paths of `update` whose change the tree at `sha` does not hold, by the shared predicate
 * (`updatePathGaps` in `platform-update-containment.ts`, the one the submit and approve checks
 * use): the update's own blob (equal blob ids are equal bytes), a delete with the path gone, a
 * hand-merged text file with every line the update adds and none it removes, counted, or a
 * `package.json` / `pnpm-lock.yaml` with every dependency change the update makes.
 */
export async function missingPaths(
  app: string,
  update: OwnerUpdate,
  sha: string,
  deps: Pick<RunnerPlatformUpdateDeps, 'treeAt' | 'blob'>
): Promise<string[]> {
  const [saved, target, base] = await Promise.all([
    deps.treeAt(app, sha),
    deps.treeAt(app, update.commitSha),
    deps.treeAt(app, update.baseCommitSha),
  ]);
  const read = async (blobSha: string | undefined) => (blobSha ? deps.blob(app, blobSha) : null);
  return missingUpdatePaths(update.paths, async (path) => {
    const want = target.get(path);
    const have = saved.get(path);
    // Equal blob ids are equal bytes: one read, and the predicate's exact-bytes clause holds.
    if (want !== undefined && have === want) {
      const bytes = await read(want);
      return { want: bytes, base: null, have: bytes };
    }
    const [w, b, h] = await Promise.all([read(want), read(base.get(path)), read(have)]);
    return { want: w, base: b, have: h };
  });
}

/**
 * The runner reports one update: `conflicted`, or `merged` once the sandbox holds it (the save
 * runs here, and its commit is the merge commit). The update must be one of THIS app's: it is
 * looked up by its commit under the app the runner names, as the user.
 */
export async function answerPlatformUpdateResolve(
  userId: number,
  body: { app: string; id: string; commitSha: string; outcome: 'merged' | 'conflicted' },
  deps: RunnerPlatformUpdateDeps
): Promise<Answer> {
  if (!SOURCE_SLUG_RE.test(body.app) || !isCommitSha(body.commitSha)) return NOT_FOUND;
  const admitted = await gate(userId, deps);
  if ('answer' in admitted) return admitted.off ? DISABLED : admitted.answer;
  let verdict: { verified: boolean; update: OwnerUpdate | null };
  try {
    verdict = await deps.verifyCommit({ userId, slug: body.app, commitSha: body.commitSha });
  } catch (err) {
    if (isNotFound(err)) return NOT_FOUND;
    throw err;
  }
  const found = verdict.update;
  if (!found || found.id !== body.id) return NOT_FOUND;
  // Not verified (withdrawn, or its author is not staff now: `verifyPlatformUpdateCommit` folds
  // both in): refused before anything is saved to `main`.
  if (verdict.verified !== true)
    return {
      status: 409,
      json: { resolved: false, reason: 'withdrawn' } satisfies ResolveAnswer,
    };

  const resolve = async (outcome: 'merged' | 'conflicted', mergeCommitSha?: string) => {
    try {
      await deps.resolve({ userId, id: body.id, outcome, mergeCommitSha: mergeCommitSha ?? null });
    } catch (err) {
      if (err instanceof TRPCError && err.code === 'CONFLICT')
        return {
          status: 409,
          json: { resolved: false, reason: 'conflict' } satisfies ResolveAnswer,
        };
      throw err;
    }
    const json: ResolveAnswer =
      outcome === 'merged'
        ? { resolved: true, outcome, mergeCommitSha: mergeCommitSha! }
        : { resolved: true, outcome };
    return { status: 200, json };
  };
  /** `merged` with `sha`, once its tree holds the update; otherwise left as it is. */
  const mergedAt = async (sha: string) => {
    const missing = await missingPaths(body.app, found, sha, deps);
    if (missing.length)
      return {
        status: 200,
        json: { resolved: false, reason: 'incomplete', paths: missing } satisfies ResolveAnswer,
      };
    return resolve('merged', sha);
  };

  if (body.outcome === 'conflicted') return resolve('conflicted');

  const saved = await deps.save({ userId, app: body.app });
  if (saved.kind === 'committed') {
    if (saved.branch === SOURCE_MAIN_BRANCH && isCommitSha(saved.sha)) return mergedAt(saved.sha);
    // On the assistant's branch, not `main`: the owner merges that branch, and the update with it.
    const answer = await resolve('conflicted');
    return answer.status === 200
      ? {
          status: 200,
          json: { resolved: false, reason: 'assistant-branch' } satisfies ResolveAnswer,
        }
      : answer;
  }
  if (saved.kind === 'unchanged') {
    // The sandbox already is what the last save wrote: that commit, when it is on main and holds it.
    const last = await deps.lastSave(body.app);
    if (last?.branch === SOURCE_MAIN_BRANCH && last.sha && isCommitSha(last.sha))
      return mergedAt(last.sha);
  }
  return { status: 200, json: { resolved: false, reason: saved.kind } satisfies ResolveAnswer };
}
