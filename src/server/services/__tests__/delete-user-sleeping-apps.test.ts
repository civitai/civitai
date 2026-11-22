import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as HibernationRepoModule from '~/server/services/app-hibernation/hibernation.repo';
import type * as ArchiveS3 from '~/utils/app-archive-s3';
import type * as HibernationDeps from '~/server/services/app-hibernation/hibernation-deps';
import {
  fakeRepo,
  fakeStore,
  NOW,
} from '~/server/services/app-hibernation/__tests__/hibernation.fakes';

/**
 * Account deletion takes the user's sleeping apps with it: `deleteUser` (the one path both the
 * self-service and the moderator deletion go through) removes their rows and every stored object
 * under their prefix. Driven through the REAL `deleteUser`; replaced are the database (canonical
 * mock), the sleeping-app table (in-memory) and the archive store (in-memory).
 */

const h = vi.hoisted(() => ({
  storeConfigured: true,
  /** What the legal-hold check answers: `null` is "could not be read". */
  hold: false as boolean | null,
  /** A hold that lands after deleteUser's own check: only the later content-removal reads see it. */
  lateHold: false,
  log: [] as string[],
  repo: undefined as unknown as ReturnType<typeof fakeRepo>,
  store: undefined as unknown as ReturnType<typeof fakeStore>,
  /** The bundle store App Assistant's frozen transcripts live in: key -> body. */
  bundles: new Map<string, string>(),
  failBundleDeletes: false,
}));

// The bundle store's S3 client (a process boundary): an in-memory bucket for List / Delete.
vi.mock('~/utils/s3-client-factory', () => ({
  newS3Client: () => ({
    send: async (command: { constructor: { name: string }; input: Record<string, string> }) => {
      const { name } = command.constructor;
      if (name === 'ListObjectsV2Command')
        return {
          Contents: [...h.bundles.keys()]
            .filter((Key) => Key.startsWith(command.input.Prefix ?? ''))
            .map((Key) => ({ Key })),
          IsTruncated: false,
        };
      if (name === 'DeleteObjectCommand') {
        if (h.failBundleDeletes) throw new Error('store refused');
        h.bundles.delete(command.input.Key!);
        return {};
      }
      return {};
    },
  }),
}));

vi.mock('~/server/services/legal-hold.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertAccountNotUnderLegalHold: async () => ({ markerView: false }),
  isAccountUnderLegalHold: async () => h.hold,
  areAccountsUnderLegalHold: async (ids: number[]) =>
    new Map(ids.map((id) => [id, h.hold !== false])),
  isContentRemovalHeld: async () => (h.hold !== false ? h.hold : h.lateHold),
  areContentRemovalsHeld: async (ids: number[]) =>
    new Map(ids.map((id) => [id, h.hold !== false || h.lateHold])),
}));
vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => ({ wipeAccount: vi.fn() }),
}));
vi.mock('~/server/services/app-hibernation/hibernation.repo', async (importOriginal) => ({
  ...(await importOriginal<typeof HibernationRepoModule>()),
  get hibernationRepo() {
    return h.repo.repo;
  },
}));
// The job's dependencies: the same in-memory table and store `deleteUser` used.
vi.mock('~/server/services/app-hibernation/hibernation-deps', async (importOriginal) => ({
  ...(await importOriginal<typeof HibernationDeps>()),
  defaultHibernationDeps: async () => ({
    repo: h.repo.repo,
    store: h.storeConfigured ? h.store.store : null,
    now: () => NOW,
    report: () => undefined,
  }),
}));
vi.mock('~/utils/app-archive-s3', async (importOriginal) => ({
  ...(await importOriginal<typeof ArchiveS3>()),
  archiveStoreConfig: () => ({
    endpoint: 'https://store.test',
    bucket: 'b',
    accessKeyId: 'k',
    secretAccessKey: 's',
  }),
  createArchiveStore: () => h.store.store,
}));

import * as UserService from '~/server/services/user.service';
import { sweepHibernationObjectsJob } from '~/server/jobs/sweep-hibernation-objects';

const USER_ID = 4_343;
const OTHER_ID = 4_454;

beforeEach(() => {
  vi.clearAllMocks();
  h.log = [];
  h.storeConfigured = true;
  h.hold = false;
  h.lateHold = false;
  h.repo = fakeRepo(h.log);
  h.store = fakeStore(h.log);
  dbMock.dbWrite.user.findFirst.mockResolvedValue({ id: USER_ID, meta: {} });
  dbMock.dbWrite.user.update.mockResolvedValue({});
  dbMock.dbWrite.model.updateMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.account.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.session.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.userEngagement.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.$transaction.mockImplementation(async (ops: unknown) => ops);
});

function sleeping(userId: number, appKey: string) {
  const objectKey = `archives/${userId}/${appKey}/a.zip`;
  const secretsObjectKey = `archives/${userId}/${appKey}/a.secrets`;
  h.store.objects.set(objectKey, Buffer.from('zip'));
  h.store.objects.set(secretsObjectKey, Buffer.from('sealed'));
  h.repo.rows.set(`${userId}/${appKey}`, {
    userId,
    appKey,
    attemptId: '88888888-8888-4888-8888-888888888888',
    objectKey,
    sha256: 'a'.repeat(64),
    bytes: 3,
    excluded: [],
    secretsObjectKey,
    secretsSha256: 'b'.repeat(64),
    secretsBytes: 6,
    secretsWrappedKey: 'v1.x',
    reason: 'retention',
    appCreatedAt: null,
    lastActivityAt: null,
    hibernatedAt: new Date(0),
  });
}

describe('deleteUser — sleeping apps', () => {
  it('removes the deleted user’s sleeping-app rows and stored objects, and no one else’s', async () => {
    sleeping(USER_ID, 'tip-calculator');
    sleeping(USER_ID, 'habit-tracker');
    sleeping(OTHER_ID, 'tip-calculator');

    await UserService.deleteUser({ id: USER_ID, actorId: USER_ID });

    expect([...h.repo.rows.keys()]).toEqual([`${OTHER_ID}/tip-calculator`]);
    expect([...h.store.objects.keys()].sort()).toEqual([
      `archives/${OTHER_ID}/tip-calculator/a.secrets`,
      `archives/${OTHER_ID}/tip-calculator/a.zip`,
    ]);
  });

  it('a hold landing after the check keeps the sleeping apps, in deleteUser and the sweep', async () => {
    sleeping(USER_ID, 'tip-calculator');
    h.lateHold = true;

    await UserService.deleteUser({ id: USER_ID, actorId: USER_ID });

    // The deletion itself ran.
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalled();
    expect(dbMock.dbWrite.account.deleteMany).toHaveBeenCalled();
    expect([...h.repo.rows.keys()]).toEqual([`${USER_ID}/tip-calculator`]);
    expect(h.store.objects.size).toBe(2);

    h.repo.accounts.set(USER_ID, 'deleted');
    const res = (await (
      await sweepHibernationObjectsJob.run({} as never)
    ).result) as Record<string, unknown>;
    expect(res.heldAccounts).toBe(1);
    expect(h.repo.rows.size).toBe(1);
    expect(h.store.objects.size).toBe(2);
  });

  it('a failed sleeping-apps step keeps the rows; the hourly sweep job then leaves nothing for that user', async () => {
    sleeping(USER_ID, 'tip-calculator');
    sleeping(OTHER_ID, 'tip-calculator');
    h.store.state.failDeletes = true;

    await UserService.deleteUser({ id: USER_ID, actorId: USER_ID }); // the step fails; deleteUser does not throw
    expect([...h.repo.rows.keys()].sort()).toEqual(
      [`${OTHER_ID}/tip-calculator`, `${USER_ID}/tip-calculator`].sort()
    );

    // The deletion committed `deletedAt` on the User row; the store recovers.
    h.repo.accounts.set(USER_ID, 'deleted');
    h.store.state.failDeletes = false;
    await (
      await sweepHibernationObjectsJob.run({} as never)
    ).result;

    expect([...h.repo.rows.keys()]).toEqual([`${OTHER_ID}/tip-calculator`]);
    expect([...h.store.objects.keys()].filter((k) => k.startsWith(`archives/${USER_ID}/`))).toEqual(
      []
    );
  });

  it('the sweep job is NOT flag-gated: it finishes a deleted account whatever the flag says', async () => {
    sleeping(USER_ID, 'tip-calculator');
    h.repo.accounts.set(USER_ID, 'deleted');
    // No flag is consulted at all; the counts are the job's one log line per run.
    expect(await (await sweepHibernationObjectsJob.run({} as never)).result).toEqual({
      scanned: 0,
      removed: 0,
      orphansHeld: 0,
      deletedAccountsFinished: 1,
      deletedAccountRowsFinished: 1,
      deletedAccountObjectsRemoved: 2,
      heldAccounts: 0,
      errors: 0,
    });
    expect(h.repo.rows.size).toBe(0);
    expect(h.store.objects.size).toBe(0);
  });

  it('a deleted account the sweep cannot finish is counted as an error, and its rows stay for the next run', async () => {
    sleeping(USER_ID, 'tip-calculator');
    h.repo.accounts.set(USER_ID, 'deleted');
    h.store.state.failDeletes = true;
    expect(await (await sweepHibernationObjectsJob.run({} as never)).result).toEqual({
      scanned: 2,
      removed: 0,
      orphansHeld: 0,
      deletedAccountsFinished: 0,
      deletedAccountRowsFinished: 0,
      deletedAccountObjectsRemoved: 0,
      heldAccounts: 0,
      errors: 1,
    });
    expect(h.repo.rows.size).toBe(1);
  });

  it('with no archive store configured the sweep job is a no-op', async () => {
    sleeping(USER_ID, 'tip-calculator');
    h.repo.accounts.set(USER_ID, 'deleted');
    h.storeConfigured = false;
    expect(await (await sweepHibernationObjectsJob.run({} as never)).result).toEqual({
      skipped: 'no archive store configured',
    });
    expect(h.repo.rows.size).toBe(1);
    expect(h.store.objects.size).toBe(2);
  });

  it.each([
    ['under a legal hold', true],
    ['whose hold cannot be read', null],
  ])('the sweep job leaves a deleted account %s untouched', async (_label, hold) => {
    sleeping(USER_ID, 'tip-calculator');
    h.repo.accounts.set(USER_ID, 'deleted');
    h.hold = hold;
    const res = (await (
      await sweepHibernationObjectsJob.run({} as never)
    ).result) as Record<string, unknown>;
    expect(res.heldAccounts).toBe(1);
    expect(res.deletedAccountsFinished).toBe(0);
    expect(h.repo.rows.size).toBe(1);
    expect(h.store.objects.size).toBe(2);
  });

  it('a missing table is a FAILED run too, never a quiet skip', async () => {
    h.repo.repo.deletedAccountsWithRows = async () => {
      throw Object.assign(new Error('relation "app_sandbox_hibernations" does not exist'), {
        code: '42P01',
      });
    };
    await expect((await sweepHibernationObjectsJob.run({} as never)).result).rejects.toThrow(
      /does not exist/
    );
  });

  it('a sweep that fails is a FAILED run (the job runner counts it), not a quiet success', async () => {
    h.repo.repo.deletedAccountsWithRows = async () => {
      throw new Error('database unavailable');
    };
    await expect((await sweepHibernationObjectsJob.run({} as never)).result).rejects.toThrow(
      /database unavailable/
    );
  });
});

/**
 * App Assistant's chat ↔ app links go with the account: `deleteUser` is a soft delete, so the
 * table's FK cascade never fires, and its `delete-app-assistant-links` step removes them. Held while
 * content removal is held; a table not applied yet is nothing to delete, never a logged failure.
 */
describe('deleteUser — App Assistant session links', () => {
  const links = () => dbMock.dbWrite.appAssistantSessionLink.deleteMany;
  const stepErrors = () =>
    loggingMock.logToAxiom.mock.calls.filter(
      ([entry]) =>
        (entry as { name?: string; type?: string }).name === 'delete-app-assistant-links' &&
        (entry as { type?: string }).type === 'error'
    );

  it('deletes the deleted user’s link rows, and only theirs', async () => {
    links().mockResolvedValue({ count: 2 });
    await UserService.deleteUser({ id: USER_ID, actorId: USER_ID });
    expect(links()).toHaveBeenCalledTimes(1);
    expect(links()).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    expect(stepErrors()).toEqual([]);
  });

  it('a hold landing after the check keeps the link rows', async () => {
    h.lateHold = true;
    await UserService.deleteUser({ id: USER_ID, actorId: USER_ID });
    expect(dbMock.dbWrite.account.deleteMany).toHaveBeenCalled();
    expect(links()).not.toHaveBeenCalled();
  });

  it('the table not applied yet is nothing to delete: no failure is logged', async () => {
    links().mockRejectedValue(
      Object.assign(new Error('The table `app_assistant_session_links` does not exist'), {
        code: 'P2021',
      })
    );
    await expect(UserService.deleteUser({ id: USER_ID, actorId: USER_ID })).resolves.toBeDefined();
    expect(links()).toHaveBeenCalledTimes(1);
    expect(stepErrors()).toEqual([]);
  });

  it('any other failure is logged and the deletion still completes', async () => {
    links().mockRejectedValue(new Error('connection reset'));
    await expect(UserService.deleteUser({ id: USER_ID, actorId: USER_ID })).resolves.toBeDefined();
    expect(stepErrors()).toHaveLength(1);
 * App Assistant session traces go with the account too (retention: "request lifetime + account
 * delete"): the REAL `deleteUser` deletes the user's frozen chat transcripts from the bundle store,
 * then their trace and link rows; a held account keeps them, and a store that refuses a delete keeps
 * the rows (so they still name what is left).
 */
describe('deleteUser — App Assistant session traces', () => {
  const MINE = 'app-assistant-transcripts/pubreq_mine/1a2b.json';
  const STRAY = 'app-assistant-transcripts/pubreq_mine/3c4d.json';
  const THEIRS = 'app-assistant-transcripts/pubreq_theirs/5e6f.json';

  beforeEach(() => {
    setEnv({
      BUNDLE_S3_ENDPOINT: 'https://bundles.test',
      BUNDLE_S3_ACCESS_KEY_ID: 'test-only',
      BUNDLE_S3_SECRET_ACCESS_KEY: 'test-only',
      BUNDLE_S3_BUCKET: 'bundles-test',
    });
    h.bundles = new Map([
      [MINE, '{}'],
      [STRAY, '{}'],
      [THEIRS, '{}'],
    ]);
    h.failBundleDeletes = false;
    dbMock.dbWrite.appPublishRequestTrace.findMany.mockImplementation(async (args: unknown) =>
      (args as { where: { userId: number } }).where.userId === USER_ID
        ? [{ publishRequestId: 'pubreq_mine', snapshots: [{ conversationId: 'c', key: MINE }] }]
        : []
    );
    dbMock.dbWrite.appPublishRequestTrace.deleteMany.mockResolvedValue({ count: 1 });
    dbMock.dbWrite.appAssistantSessionLink.deleteMany.mockResolvedValue({ count: 3 });
    dbMock.dbWrite.$transaction.mockImplementation(async (ops: unknown) =>
      Promise.all(ops as Promise<unknown>[])
    );
  });

  it('deletes the user’s frozen transcripts (a stray under their request too) and their rows; no one else’s', async () => {
    await UserService.deleteUser({ id: USER_ID, actorId: USER_ID });
    expect([...h.bundles.keys()]).toEqual([THEIRS]);
    expect(dbMock.dbWrite.appPublishRequestTrace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } })
    );
    expect(dbMock.dbWrite.appPublishRequestTrace.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
    });
    expect(dbMock.dbWrite.appAssistantSessionLink.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
    });
  });

  it('a hold landing after the check keeps the transcripts and the rows', async () => {
    h.lateHold = true;
    await UserService.deleteUser({ id: USER_ID, actorId: USER_ID });
    expect(dbMock.dbWrite.account.deleteMany).toHaveBeenCalled();
    expect(h.bundles.size).toBe(3);
    expect(dbMock.dbWrite.appPublishRequestTrace.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appAssistantSessionLink.deleteMany).not.toHaveBeenCalled();
  });

  it('a store that refuses the deletes keeps the rows, and the account deletion still completes', async () => {
    h.failBundleDeletes = true;
    await expect(UserService.deleteUser({ id: USER_ID, actorId: USER_ID })).resolves.toBeDefined();
    expect(h.bundles.has(MINE)).toBe(true);
    expect(dbMock.dbWrite.appPublishRequestTrace.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appAssistantSessionLink.deleteMany).not.toHaveBeenCalled();
  });
});
