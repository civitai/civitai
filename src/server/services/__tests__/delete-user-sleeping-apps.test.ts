import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
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
  log: [] as string[],
  repo: undefined as unknown as ReturnType<typeof fakeRepo>,
  store: undefined as unknown as ReturnType<typeof fakeStore>,
}));

vi.mock('~/server/services/legal-hold.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertAccountNotUnderLegalHold: async () => ({ markerView: false }),
  isAccountUnderLegalHold: async () => h.hold,
  areAccountsUnderLegalHold: async (ids: number[]) =>
    new Map(ids.map((id) => [id, h.hold !== false])),
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

    await UserService.deleteUser({ id: USER_ID });

    expect([...h.repo.rows.keys()]).toEqual([`${OTHER_ID}/tip-calculator`]);
    expect([...h.store.objects.keys()].sort()).toEqual([
      `archives/${OTHER_ID}/tip-calculator/a.secrets`,
      `archives/${OTHER_ID}/tip-calculator/a.zip`,
    ]);
  });

  it('a failed sleeping-apps step keeps the rows; the hourly sweep job then leaves nothing for that user', async () => {
    sleeping(USER_ID, 'tip-calculator');
    sleeping(OTHER_ID, 'tip-calculator');
    h.store.state.failDeletes = true;

    await UserService.deleteUser({ id: USER_ID }); // the step fails; deleteUser does not throw
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
