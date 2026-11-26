import { TRPCError } from '@trpc/server';
import type { AssistantSaveResult } from '~/server/services/blocks/app-source-repo.service';
import type { SessionUser } from '~/types/session';

/**
 * STAFF PLATFORM UPDATES for App Assistant's server runner: the pending updates of the open app,
 * with the files each one changes, and the report of what the runner did with one. FOR the user the
 * run grant names, through the owner API of `app-platform-update.service.ts` (owner or accepted
 * collaborator, flag on).
 *
 * The runner's sandbox is not a git checkout, so the runner applies an update as file contents:
 * each path the update's RECORD lists, as it is at the recorded `commitSha` (what the update writes)
 * and at its `baseCommitSha` (what it was cut from). Both are read by commit id, never by the
 * update's branch, so a commit added to the branch after the push is never applied.
 *
 * The answers are here, without I/O (`RunnerPlatformUpdateDeps`); the routes are
 * `runner-platform-updates-route.ts`.
 *
 *   POST platform-updates           `{ grant, app }` → `{ updates: RunnerPlatformUpdate[] }`
 *   POST platform-updates/resolve   `{ grant, app, id, commitSha, outcome }` → `ResolveAnswer`
 *
 * Off (the flag, Apps for the user, an app with no block, or not theirs): the list answers
 * `{ updates: [] }`, so a runner asking at every reply's start changes nothing.
 *
 * `merged` saves the app from the sandbox first (the same save as every App Assistant change) and
 * reports the commit that save wrote on the source repo's `main` as the merge commit. A save that
 * went to the assistant's side branch is not on `main`, so the update is reported `conflicted`.
 */

/** The most bytes of file content one list answer carries (the most one update may write). */
export const RUNNER_PLATFORM_UPDATE_MAX_BYTES = 8 * 1024 * 1024;

const SOURCE_MAIN_BRANCH = 'main';

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
  by: { username: string | null };
  /** `verifyCommit`'s verdict: the only source of the "verified Civitai staff" line. */
  verified: boolean;
  files: RunnerPlatformUpdateFile[];
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
  user: (
    userId: number
  ) => Promise<
    | { refusal: { status: number; error: string; code: string }; user?: undefined }
    | { refusal: null; user: SessionUser }
  >;
  /** The `app-blocks-platform-updates` flag and Apps for the user. */
  enabled: (user: SessionUser) => Promise<boolean>;
  listPending: (args: { userId: number; slug: string }) => Promise<OwnerUpdate[]>;
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

const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function textOf(content: Buffer): string | null {
  const text = content.toString('utf8');
  return Buffer.from(text, 'utf8').equals(content) ? text : null;
}

async function gate(
  userId: number,
  deps: RunnerPlatformUpdateDeps
): Promise<{ answer: Answer } | { ok: true }> {
  const subject = await deps.user(userId);
  if (subject.refusal)
    return {
      answer: {
        status: subject.refusal.status,
        json: { error: subject.refusal.error, code: subject.refusal.code },
      },
    };
  if (!(await deps.enabled(subject.user))) return { answer: NO_UPDATES };
  return { ok: true };
}

/** A NOT_FOUND from the owner gate (no such app, not theirs): no updates, and no oracle. */
function isNotFound(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'NOT_FOUND';
}

/** The app's pending updates, oldest first, each with its files at its two recorded commits. */
export async function answerPlatformUpdates(
  userId: number,
  app: string,
  deps: RunnerPlatformUpdateDeps
): Promise<Answer> {
  if (!SLUG_RE.test(app)) return NO_UPDATES;
  const admitted = await gate(userId, deps);
  if ('answer' in admitted) return admitted.answer;
  let pending: OwnerUpdate[];
  try {
    pending = await deps.listPending({ userId, slug: app });
  } catch (err) {
    if (isNotFound(err)) return NO_UPDATES;
    throw err;
  }
  const updates: RunnerPlatformUpdate[] = [];
  for (const update of pending) {
    if (!COMMIT_SHA_RE.test(update.commitSha) || !COMMIT_SHA_RE.test(update.baseCommitSha))
      continue;
    const { verified } = await deps.verifyCommit({
      userId,
      slug: app,
      commitSha: update.commitSha,
    });
    const [base, target] = await Promise.all([
      deps.treeAt(app, update.baseCommitSha),
      deps.treeAt(app, update.commitSha),
    ]);
    let bytes = 0;
    const read = async (blobSha: string | undefined) => {
      if (!blobSha) return { text: null, binary: false };
      const content = await deps.blob(app, blobSha);
      bytes += content.byteLength;
      if (bytes > RUNNER_PLATFORM_UPDATE_MAX_BYTES) throw new Error('platform update too large');
      const text = textOf(content);
      return { text, binary: text === null };
    };
    const files: RunnerPlatformUpdateFile[] = [];
    // The record's paths, never a diff of the branch: exactly what the staff commit changes.
    for (const { path, operation } of update.paths) {
      const [was, now] = [await read(base.get(path)), await read(target.get(path))];
      files.push({
        path,
        operation,
        base: was.text,
        update: now.text,
        ...(was.binary || now.binary ? { binary: true as const } : {}),
      });
    }
    updates.push({
      id: update.id,
      commitSha: update.commitSha,
      baseCommitSha: update.baseCommitSha,
      reason: update.reason,
      touchesManifest: update.touchesManifest === true,
      by: { username: update.by.username ?? null },
      verified: verified === true,
      files,
    });
  }
  return { status: 200, json: { updates } };
}

export type ResolveAnswer =
  | { resolved: true; outcome: 'merged'; mergeCommitSha: string }
  | { resolved: true; outcome: 'conflicted' }
  | { resolved: false; reason: string };

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
  if (!SLUG_RE.test(body.app) || !COMMIT_SHA_RE.test(body.commitSha)) return NOT_FOUND;
  const admitted = await gate(userId, deps);
  if ('answer' in admitted)
    return admitted.answer === NO_UPDATES
      ? { status: 404, json: { error: 'Platform updates are not enabled', code: 'disabled' } }
      : admitted.answer;
  let found: OwnerUpdate | null;
  try {
    found = (await deps.verifyCommit({ userId, slug: body.app, commitSha: body.commitSha })).update;
  } catch (err) {
    if (isNotFound(err)) return NOT_FOUND;
    throw err;
  }
  if (!found || found.id !== body.id) return NOT_FOUND;

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

  if (body.outcome === 'conflicted') return resolve('conflicted');

  const saved = await deps.save({ userId, app: body.app });
  if (saved.kind === 'committed') {
    if (saved.branch === SOURCE_MAIN_BRANCH && COMMIT_SHA_RE.test(saved.sha))
      return resolve('merged', saved.sha);
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
    // The sandbox already is what the last save wrote: that commit holds the update when it is on main.
    const last = await deps.lastSave(body.app);
    if (last?.branch === SOURCE_MAIN_BRANCH && last.sha && COMMIT_SHA_RE.test(last.sha))
      return resolve('merged', last.sha);
  }
  return { status: 200, json: { resolved: false, reason: saved.kind } satisfies ResolveAnswer };
}
