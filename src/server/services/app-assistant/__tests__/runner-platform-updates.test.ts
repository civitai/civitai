import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import {
  answerPlatformUpdateResolve,
  answerPlatformUpdates,
  RUNNER_PLATFORM_UPDATES_MAX_BYTES,
  type OwnerUpdate,
  type RunnerPlatformUpdateDeps,
} from '~/server/services/app-assistant/runner-platform-updates';
import type { AssistantSaveResult } from '~/server/services/blocks/app-source-repo.service';
import type { SessionUser } from '~/types/session';

/**
 * The server half of staff platform updates in App Assistant's runner: the files each pending update
 * changes, read at its RECORDED commits (never its branch), and the report of an outcome, where
 * `merged` refuses a withdrawn update before saving, saves the app, and names the commit that save
 * wrote on `main` once its tree holds the update. The owner API and the git host are injected fakes
 * (`RunnerPlatformUpdateDeps`); the git host is a map of trees by ref.
 */

const USER = 7;
const APP = 'my-app';
const COMMIT = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const SAVED = 'c'.repeat(40);
const BRANCH_TIP = 'platform-update/apu_1';

const update: OwnerUpdate = {
  id: 'apu_1',
  commitSha: COMMIT,
  baseCommitSha: BASE,
  reason: 'Bump the SDK',
  paths: [
    { path: 'package.json', operation: 'update' },
    { path: 'src/new.ts', operation: 'create' },
    { path: 'src/old.ts', operation: 'delete' },
  ],
  touchesManifest: false,
  status: 'pending',
  by: { username: 'staffer', verifiedStaff: true },
};

/** blob sha → content; ref → path → blob sha. The branch tip carries a commit added after the push. */
const blobs = new Map<string, string>([
  ['blob-pkg-base', '{"v":1}\n'],
  ['blob-pkg-new', '{"v":2}\n'],
  ['blob-new', 'export const added = 1;\n'],
  ['blob-old', 'old\n'],
  ['blob-pkg-tip', '{"v":3}\n'],
  ['blob-evil', 'sneaked in\n'],
  ['blob-pkg-merged', '{"v":2}\n{"mine":true}\n'],
]);
const trees = new Map<string, Map<string, string>>([
  [
    BASE,
    new Map([
      ['package.json', 'blob-pkg-base'],
      ['src/old.ts', 'blob-old'],
    ]),
  ],
  [
    COMMIT,
    new Map([
      ['package.json', 'blob-pkg-new'],
      ['src/new.ts', 'blob-new'],
    ]),
  ],
  // What the assistant's save wrote on main: the update, exactly.
  [
    SAVED,
    new Map([
      ['package.json', 'blob-pkg-new'],
      ['src/new.ts', 'blob-new'],
    ]),
  ],
  [
    BRANCH_TIP,
    new Map([
      ['package.json', 'blob-pkg-tip'],
      ['src/new.ts', 'blob-new'],
      ['src/evil.ts', 'blob-evil'],
    ]),
  ],
]);

function fakes(overrides: Partial<RunnerPlatformUpdateDeps> = {}) {
  const seen = {
    refs: [] as string[],
    blobs: 0,
    resolved: [] as Array<{ id: string; outcome: string; mergeCommitSha?: string | null }>,
    saves: 0,
    lists: 0,
    users: 0,
  };
  const deps: RunnerPlatformUpdateDeps = {
    flagOn: async () => true,
    user: async () => {
      seen.users++;
      return { refusal: null, user: { id: USER } as SessionUser };
    },
    appsEnabled: async () => true,
    listOpen: async () => {
      seen.lists++;
      return [update];
    },
    verifyCommit: async ({ commitSha }) =>
      commitSha === COMMIT ? { verified: true, update } : { verified: false, update: null },
    resolve: async (args) => {
      seen.resolved.push({
        id: args.id,
        outcome: args.outcome,
        mergeCommitSha: args.mergeCommitSha,
      });
      return {};
    },
    treeAt: async (_slug, ref) => {
      seen.refs.push(ref);
      return trees.get(ref) ?? new Map();
    },
    blob: async (_slug, sha) => {
      seen.blobs++;
      return Buffer.from(blobs.get(sha)!, 'utf8');
    },
    save: async () => {
      seen.saves++;
      return { kind: 'committed', sha: SAVED, branch: 'main', conflict: false };
    },
    lastSave: async () => null,
    ...overrides,
  };
  return { deps, seen };
}

describe('answerPlatformUpdates', () => {
  it("lists each update's recorded paths at its recorded commit and base, never at the branch", async () => {
    const { deps, seen } = fakes();
    const answer = await answerPlatformUpdates(USER, APP, deps);
    expect(answer).toEqual({
      status: 200,
      json: {
        updates: [
          {
            id: 'apu_1',
            commitSha: COMMIT,
            baseCommitSha: BASE,
            reason: 'Bump the SDK',
            touchesManifest: false,
            status: 'pending',
            by: { username: 'staffer' },
            verified: true,
            paths: [
              { path: 'package.json', operation: 'update' },
              { path: 'src/new.ts', operation: 'create' },
              { path: 'src/old.ts', operation: 'delete' },
            ],
            files: [
              { path: 'package.json', operation: 'update', base: '{"v":1}\n', update: '{"v":2}\n' },
              {
                path: 'src/new.ts',
                operation: 'create',
                base: null,
                update: 'export const added = 1;\n',
              },
              { path: 'src/old.ts', operation: 'delete', base: 'old\n', update: null },
            ],
          },
        ],
      },
    });
    expect([...seen.refs].sort()).toEqual([BASE, COMMIT].sort());
  });

  it('verified is verifyCommit’s verdict, not the record’s verifiedStaff, and an unverified update’s files are never read', async () => {
    const { deps, seen } = fakes({ verifyCommit: async () => ({ verified: false, update }) });
    const answer = await answerPlatformUpdates(USER, APP, deps);
    const listed = (answer.json as { updates: Array<Record<string, unknown>> }).updates[0];
    expect(listed.verified).toBe(false);
    expect(listed.files).toEqual([]);
    expect(listed.paths).toEqual(update.paths);
    expect(seen.refs).toEqual([]);
    expect(seen.blobs).toBe(0);
  });

  it('a conflicted update is listed too, with its status; a merged or superseded one is not', async () => {
    const { deps } = fakes({
      listOpen: async () => [
        { ...update, status: 'conflicted' },
        { ...update, id: 'apu_merged', status: 'merged' },
        { ...update, id: 'apu_gone', status: 'superseded' },
      ],
    });
    const listed = (
      (await answerPlatformUpdates(USER, APP, deps)).json as {
        updates: Array<{ id: string; status: string }>;
      }
    ).updates;
    expect(listed.map((u) => `${u.id}:${u.status}`)).toEqual(['apu_1:conflicted']);
  });

  it('an update past what is left of the answer’s budget is listed tooLarge with no files; the rest still are, and nothing throws', async () => {
    const huge = 'x'.repeat(RUNNER_PLATFORM_UPDATES_MAX_BYTES);
    const bigCommit = 'e'.repeat(40);
    const big: OwnerUpdate = {
      ...update,
      id: 'apu_big',
      commitSha: bigCommit,
      paths: [{ path: 'big.txt', operation: 'create' }],
    };
    const { deps } = fakes({
      listOpen: async () => [big, update],
      verifyCommit: async ({ commitSha }) => ({
        verified: true,
        update: commitSha === bigCommit ? big : update,
      }),
      treeAt: async (_slug, ref) =>
        ref === bigCommit ? new Map([['big.txt', 'blob-huge']]) : trees.get(ref) ?? new Map(),
      blob: async (_slug, sha) =>
        Buffer.from(sha === 'blob-huge' ? `${huge}!` : blobs.get(sha)!, 'utf8'),
    });
    const answer = await answerPlatformUpdates(USER, APP, deps);
    expect(answer.status).toBe(200);
    const listed = (
      answer.json as { updates: Array<{ id: string; tooLarge?: true; files: unknown[] }> }
    ).updates;
    expect(listed.map((u) => [u.id, u.tooLarge ?? false, u.files.length])).toEqual([
      ['apu_big', true, 0],
      ['apu_1', false, 3],
    ]);
  });

  it('the budget is the whole answer’s: a second update that fits alone but not after the first is tooLarge', async () => {
    const half = 'y'.repeat(RUNNER_PLATFORM_UPDATES_MAX_BYTES / 2 + 1);
    const [c1, c2] = ['1'.repeat(40), '2'.repeat(40)];
    const one = (id: string, commitSha: string): OwnerUpdate => ({
      ...update,
      id,
      commitSha,
      paths: [{ path: 'half.txt', operation: 'create' }],
    });
    const records = [one('apu_a', c1), one('apu_b', c2)];
    const { deps } = fakes({
      listOpen: async () => records,
      verifyCommit: async ({ commitSha }) => ({
        verified: true,
        update: records.find((r) => r.commitSha === commitSha)!,
      }),
      treeAt: async (_slug, ref) =>
        ref === c1 || ref === c2 ? new Map([['half.txt', 'blob-half']]) : new Map(),
      blob: async () => Buffer.from(half, 'utf8'),
    });
    const listed = (
      (await answerPlatformUpdates(USER, APP, deps)).json as {
        updates: Array<{ id: string; tooLarge?: true }>;
      }
    ).updates;
    expect(listed.map((u) => [u.id, u.tooLarge ?? false])).toEqual([
      ['apu_a', false],
      ['apu_b', true],
    ]);
  });

  it('a binary file is marked binary, and its binary side is not sent as text', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
    const { deps } = fakes({
      blob: async (_slug, sha) =>
        sha === 'blob-pkg-new' ? png : Buffer.from(blobs.get(sha)!, 'utf8'),
    });
    const files = (
      (await answerPlatformUpdates(USER, APP, deps)).json as {
        updates: Array<{ files: unknown[] }>;
      }
    ).updates[0].files;
    expect(files[0]).toEqual({
      path: 'package.json',
      operation: 'update',
      base: '{"v":1}\n',
      update: null,
      binary: true,
    });
  });

  it('flag off: no updates, and the owner API is not asked', async () => {
    const { deps, seen } = fakes({ flagOn: async () => false });
    expect(await answerPlatformUpdates(USER, APP, deps)).toEqual({
      status: 200,
      json: { updates: [] },
    });
    expect(seen.lists).toBe(0);
    expect(seen.refs).toEqual([]);
  });

  it('flag off is silent even for a user the gates would refuse: the flag is read first', async () => {
    const { deps, seen } = fakes({
      flagOn: async () => false,
      user: async () => {
        seen.users++;
        return { refusal: { status: 403, error: 'No', code: 'refused' } };
      },
    });
    expect(await answerPlatformUpdates(USER, APP, deps)).toEqual({
      status: 200,
      json: { updates: [] },
    });
    expect(seen.users).toBe(0);
  });

  it('Apps off for the user: no updates', async () => {
    const { deps, seen } = fakes({ appsEnabled: async () => false });
    expect(await answerPlatformUpdates(USER, APP, deps)).toEqual({
      status: 200,
      json: { updates: [] },
    });
    expect(seen.lists).toBe(0);
  });

  it('an app that is not theirs (or has no block) answers no updates', async () => {
    const { deps } = fakes({
      listOpen: async () => {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'App not found' });
      },
    });
    expect(await answerPlatformUpdates(USER, APP, deps)).toEqual({
      status: 200,
      json: { updates: [] },
    });
  });

  it('a user the App Assistant gates refuse gets the refusal', async () => {
    const { deps, seen } = fakes({
      user: async () => ({ refusal: { status: 403, error: 'No', code: 'refused' } }),
    });
    expect(await answerPlatformUpdates(USER, APP, deps)).toEqual({
      status: 403,
      json: { error: 'No', code: 'refused' },
    });
    expect(seen.lists).toBe(0);
  });
});

describe('answerPlatformUpdateResolve', () => {
  const body = { app: APP, id: 'apu_1', commitSha: COMMIT, outcome: 'merged' as const };

  it('merged: saves the app, then records the save’s commit on main as the merge commit', async () => {
    const { deps, seen } = fakes();
    expect(await answerPlatformUpdateResolve(USER, body, deps)).toEqual({
      status: 200,
      json: { resolved: true, outcome: 'merged', mergeCommitSha: SAVED },
    });
    expect(seen.saves).toBe(1);
    expect(seen.resolved).toEqual([{ id: 'apu_1', outcome: 'merged', mergeCommitSha: SAVED }]);
  });

  it('a save that went to the assistant branch is not on main: recorded conflicted', async () => {
    const { deps, seen } = fakes({
      save: async () => ({
        kind: 'committed',
        sha: SAVED,
        branch: 'civitai-assistant',
        conflict: true,
      }),
    });
    expect(await answerPlatformUpdateResolve(USER, body, deps)).toEqual({
      status: 200,
      json: { resolved: false, reason: 'assistant-branch' },
    });
    expect(seen.resolved).toEqual([{ id: 'apu_1', outcome: 'conflicted', mergeCommitSha: null }]);
  });

  it('a save on main that does not hold the update at some path is not recorded merged', async () => {
    const PARTIAL = 'f'.repeat(40);
    const { deps, seen } = fakes({
      save: async () => {
        seen.saves++;
        return { kind: 'committed', sha: PARTIAL, branch: 'main', conflict: false };
      },
      // package.json holds it; src/new.ts was never written; src/old.ts is still there.
      treeAt: async (_slug, ref) =>
        ref === PARTIAL
          ? new Map([
              ['package.json', 'blob-pkg-new'],
              ['src/old.ts', 'blob-old'],
            ])
          : trees.get(ref) ?? new Map(),
    });
    expect(await answerPlatformUpdateResolve(USER, body, deps)).toEqual({
      status: 200,
      json: { resolved: false, reason: 'incomplete', paths: ['src/new.ts', 'src/old.ts'] },
    });
    expect(seen.resolved).toEqual([]);
  });

  it('a hand-merged file holds the update when it has every line the update adds', async () => {
    const MERGED = '9'.repeat(40);
    const { deps, seen } = fakes({
      save: async () => ({ kind: 'committed', sha: MERGED, branch: 'main', conflict: false }),
      treeAt: async (_slug, ref) =>
        ref === MERGED
          ? new Map([
              ['package.json', 'blob-pkg-merged'],
              ['src/new.ts', 'blob-new'],
            ])
          : trees.get(ref) ?? new Map(),
    });
    expect((await answerPlatformUpdateResolve(USER, body, deps)).json).toEqual({
      resolved: true,
      outcome: 'merged',
      mergeCommitSha: MERGED,
    });
    expect(seen.resolved).toEqual([{ id: 'apu_1', outcome: 'merged', mergeCommitSha: MERGED }]);
  });

  // The shared predicate (`platform-update-containment.ts`) counts what the update removes too.
  it('a hand-merged file that kept the line the update replaces does not hold it', async () => {
    const KEPT_BOTH = '7'.repeat(40);
    const { deps, seen } = fakes({
      save: async () => ({ kind: 'committed', sha: KEPT_BOTH, branch: 'main', conflict: false }),
      treeAt: async (_slug, ref) =>
        ref === KEPT_BOTH
          ? new Map([
              // `{"v":1}` (the base's) kept beside the update's `{"v":2}`.
              ['package.json', 'blob-pkg-kept-both'],
              ['src/new.ts', 'blob-new'],
            ])
          : trees.get(ref) ?? new Map(),
      blob: async (_slug, sha) =>
        Buffer.from(sha === 'blob-pkg-kept-both' ? '{"v":1}\n{"v":2}\n' : blobs.get(sha)!, 'utf8'),
    });
    expect((await answerPlatformUpdateResolve(USER, body, deps)).json).toEqual({
      resolved: false,
      reason: 'incomplete',
      paths: ['package.json'],
    });
    expect(seen.resolved).toEqual([]);
  });

  it('a file still as the update was cut from does not hold it; a binary file must be exactly the update’s', async () => {
    const STALE = '8'.repeat(40);
    const binaryBlobs = new Map([
      ['blob-bin-base', Buffer.from([0xff, 0x01])],
      ['blob-bin-new', Buffer.from([0xff, 0x02])],
      ['blob-bin-other', Buffer.from([0xff, 0x03])],
    ]);
    const binUpdate: OwnerUpdate = {
      ...update,
      paths: [
        { path: 'package.json', operation: 'update' },
        { path: 'icon.png', operation: 'update' },
      ],
    };
    const { deps, seen } = fakes({
      verifyCommit: async () => ({ verified: true, update: binUpdate }),
      save: async () => ({ kind: 'committed', sha: STALE, branch: 'main', conflict: false }),
      treeAt: async (_slug, ref) =>
        ref === STALE
          ? new Map([
              ['package.json', 'blob-pkg-base'],
              ['icon.png', 'blob-bin-other'],
            ])
          : ref === COMMIT
          ? new Map([
              ['package.json', 'blob-pkg-new'],
              ['icon.png', 'blob-bin-new'],
            ])
          : new Map([
              ['package.json', 'blob-pkg-base'],
              ['icon.png', 'blob-bin-base'],
            ]),
      blob: async (_slug, sha) => binaryBlobs.get(sha) ?? Buffer.from(blobs.get(sha)!, 'utf8'),
    });
    expect((await answerPlatformUpdateResolve(USER, body, deps)).json).toEqual({
      resolved: false,
      reason: 'incomplete',
      paths: ['package.json', 'icon.png'],
    });
    expect(seen.resolved).toEqual([]);
  });

  it('an unchanged save names the last save only when it is on main and holds the update', async () => {
    const unchanged = async (): Promise<AssistantSaveResult> => ({ kind: 'unchanged' });
    const lacking = fakes({
      save: unchanged,
      lastSave: async () => ({ sha: BASE, branch: 'main' }),
    });
    expect((await answerPlatformUpdateResolve(USER, body, lacking.deps)).json).toEqual({
      resolved: false,
      reason: 'incomplete',
      paths: ['package.json', 'src/new.ts', 'src/old.ts'],
    });
    expect(lacking.seen.resolved).toEqual([]);
  });

  it('an unchanged save names the last save when it is on main, and nothing otherwise', async () => {
    const unchanged = async (): Promise<AssistantSaveResult> => ({ kind: 'unchanged' });
    const onMain = fakes({
      save: unchanged,
      lastSave: async () => ({ sha: SAVED, branch: 'main' }),
    });
    expect((await answerPlatformUpdateResolve(USER, body, onMain.deps)).json).toEqual({
      resolved: true,
      outcome: 'merged',
      mergeCommitSha: SAVED,
    });
    const onSide = fakes({
      save: unchanged,
      lastSave: async () => ({ sha: SAVED, branch: 'civitai-assistant' }),
    });
    expect((await answerPlatformUpdateResolve(USER, body, onSide.deps)).json).toEqual({
      resolved: false,
      reason: 'unchanged',
    });
    expect(onSide.seen.resolved).toEqual([]);
  });

  it('a save that did not happen records nothing', async () => {
    const { deps, seen } = fakes({ save: async () => ({ kind: 'not-running' }) });
    expect((await answerPlatformUpdateResolve(USER, body, deps)).json).toEqual({
      resolved: false,
      reason: 'not-running',
    });
    expect(seen.resolved).toEqual([]);
  });

  it('conflicted: recorded without a save', async () => {
    const { deps, seen } = fakes();
    expect(
      await answerPlatformUpdateResolve(USER, { ...body, outcome: 'conflicted' }, deps)
    ).toEqual({ status: 200, json: { resolved: true, outcome: 'conflicted' } });
    expect(seen.saves).toBe(0);
    expect(seen.resolved).toEqual([{ id: 'apu_1', outcome: 'conflicted', mergeCommitSha: null }]);
  });

  it("an id that is not this app's update at that commit: 404, no save, nothing recorded", async () => {
    for (const wrong of [{ id: 'apu_other' }, { commitSha: 'd'.repeat(40) }]) {
      const { deps, seen } = fakes();
      expect(await answerPlatformUpdateResolve(USER, { ...body, ...wrong }, deps)).toEqual({
        status: 404,
        json: { error: 'No update of yours under that id', code: 'NOT_FOUND' },
      });
      expect(seen.saves).toBe(0);
      expect(seen.resolved).toEqual([]);
    }
  });

  it('an update verifyCommit does not verify (superseded, de-staffed) is refused as withdrawn BEFORE anything is saved', async () => {
    for (const verdict of [
      { verified: false, update: { ...update, status: 'superseded' } },
      { verified: false, update: { ...update, by: { username: 'staffer', verifiedStaff: false } } },
    ]) {
      for (const outcome of ['merged', 'conflicted'] as const) {
        const { deps, seen } = fakes({ verifyCommit: async () => verdict });
        expect(await answerPlatformUpdateResolve(USER, { ...body, outcome }, deps)).toEqual({
          status: 409,
          json: { resolved: false, reason: 'withdrawn' },
        });
        expect(seen.saves).toBe(0);
        expect(seen.resolved).toEqual([]);
      }
    }
  });

  it('a CONFLICT from the owner API answers 409 conflict', async () => {
    const { deps } = fakes({
      resolve: async () => {
        throw new TRPCError({ code: 'CONFLICT', message: 'already merged' });
      },
    });
    expect(await answerPlatformUpdateResolve(USER, body, deps)).toEqual({
      status: 409,
      json: { resolved: false, reason: 'conflict' },
    });
  });

  it('flag off: 404 disabled, no save, and the user is not asked', async () => {
    const { deps, seen } = fakes({ flagOn: async () => false });
    expect(await answerPlatformUpdateResolve(USER, body, deps)).toEqual({
      status: 404,
      json: { error: 'Platform updates are not enabled', code: 'disabled' },
    });
    expect(seen.saves).toBe(0);
    expect(seen.users).toBe(0);
  });

  it('Apps off for the user: 404 disabled, no save', async () => {
    const { deps, seen } = fakes({ appsEnabled: async () => false });
    expect(await answerPlatformUpdateResolve(USER, body, deps)).toEqual({
      status: 404,
      json: { error: 'Platform updates are not enabled', code: 'disabled' },
    });
    expect(seen.saves).toBe(0);
  });
});
