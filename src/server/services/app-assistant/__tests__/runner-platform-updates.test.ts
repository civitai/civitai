import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import {
  answerPlatformUpdateResolve,
  answerPlatformUpdates,
  type OwnerUpdate,
  type RunnerPlatformUpdateDeps,
} from '~/server/services/app-assistant/runner-platform-updates';
import type { AssistantSaveResult } from '~/server/services/blocks/app-source-repo.service';
import type { SessionUser } from '~/types/session';

/**
 * The server half of staff platform updates in App Assistant's runner: the files each pending update
 * changes, read at its RECORDED commits (never its branch), and the report of an outcome, where
 * `merged` saves the app first and names the commit that save wrote on `main`. The owner API and the
 * git host are injected fakes (`RunnerPlatformUpdateDeps`); the git host is a map of trees by ref.
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
    resolved: [] as Array<{ id: string; outcome: string; mergeCommitSha?: string | null }>,
    saves: 0,
    lists: 0,
  };
  const deps: RunnerPlatformUpdateDeps = {
    user: async () => ({ refusal: null, user: { id: USER } as SessionUser }),
    enabled: async () => true,
    listPending: async () => {
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
    blob: async (_slug, sha) => Buffer.from(blobs.get(sha)!, 'utf8'),
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
            by: { username: 'staffer' },
            verified: true,
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

  it('verified is verifyCommit’s verdict, not the record’s verifiedStaff', async () => {
    const { deps } = fakes({ verifyCommit: async () => ({ verified: false, update }) });
    const answer = await answerPlatformUpdates(USER, APP, deps);
    expect((answer.json as { updates: Array<{ verified: boolean }> }).updates[0].verified).toBe(
      false
    );
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
    const { deps, seen } = fakes({ enabled: async () => false });
    expect(await answerPlatformUpdates(USER, APP, deps)).toEqual({
      status: 200,
      json: { updates: [] },
    });
    expect(seen.lists).toBe(0);
    expect(seen.refs).toEqual([]);
  });

  it('an app that is not theirs (or has no block) answers no updates', async () => {
    const { deps } = fakes({
      listPending: async () => {
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

  it('a superseded update (CONFLICT from the owner API) answers 409', async () => {
    const { deps } = fakes({
      resolve: async () => {
        throw new TRPCError({ code: 'CONFLICT', message: 'superseded' });
      },
    });
    expect(await answerPlatformUpdateResolve(USER, body, deps)).toEqual({
      status: 409,
      json: { resolved: false, reason: 'conflict' },
    });
  });

  it('flag off: 404 disabled, no save', async () => {
    const { deps, seen } = fakes({ enabled: async () => false });
    expect(await answerPlatformUpdateResolve(USER, body, deps)).toEqual({
      status: 404,
      json: { error: 'Platform updates are not enabled', code: 'disabled' },
    });
    expect(seen.saves).toBe(0);
  });
});
