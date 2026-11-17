import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// No hold covers the account here; the hold itself is `account-legal-hold.behavior.test.ts`.
vi.mock('~/server/services/legal-hold.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertAccountNotUnderLegalHold: async () => ({ markerView: false }),
}));

// Any inline wipe would have to go through the maintenance object: make reaching it loud.
const wipeAccount = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => ({ wipeAccount }),
}));

import * as UserService from '~/server/services/user.service';

/**
 * "Also delete my data in apps" on self-deletion. `deleteUser` only RECORDS the request
 * (`meta.appDataRemoval`), in the deletion's own transaction; the
 * `remove-deleted-account-app-data` job does the wipe. Off by default: without the box an
 * account's app data is kept, so a restore brings it back.
 */

const USER_ID = 4_242;

function metaWritten(): Record<string, unknown> {
  const call = dbMock.dbWrite.user.update.mock.calls.find(
    ([arg]) => (arg as { data?: { meta?: unknown } }).data?.meta !== undefined
  );
  if (!call) throw new Error('deleteUser wrote no meta');
  return (call[0] as { data: { meta: Record<string, unknown> } }).data.meta;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.findFirst.mockResolvedValue({ id: USER_ID, meta: { keep: 'x' } });
  dbMock.dbWrite.user.update.mockResolvedValue({});
  dbMock.dbWrite.model.updateMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.account.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.session.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.userEngagement.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.$transaction.mockImplementation(async (ops: unknown) => ops);
});

describe('deleteUser — app-data opt-in', () => {
  it('records the request in the deletion transaction when the box is ticked, and wipes nothing inline', async () => {
    await UserService.deleteUser({ id: USER_ID, removeAppData: true });

    expect(metaWritten()).toMatchObject({ keep: 'x', appDataRemoval: 'requested' });
    // The meta write is an element of the deletion's transaction, so the request commits
    // with the deletion or not at all.
    const [ops] = dbMock.dbWrite.$transaction.mock.calls[0] as [unknown[]];
    expect(ops).toContain(dbMock.dbWrite.user.update.mock.results[0].value);
    expect(wipeAccount).not.toHaveBeenCalled();
  });

  it('records no request when the box is left off (the default)', async () => {
    await UserService.deleteUser({ id: USER_ID });

    expect(metaWritten().appDataRemoval).toBeUndefined();
    expect(wipeAccount).not.toHaveBeenCalled();
  });

  it('drops a request left over from an earlier deletion when this one leaves the box off', async () => {
    dbMock.dbWrite.user.findFirst.mockResolvedValue({
      id: USER_ID,
      meta: { keep: 'x', appDataRemoval: 'requested' },
    });

    await UserService.deleteUser({ id: USER_ID, removeAppData: false });

    expect(metaWritten()).toMatchObject({ keep: 'x' });
    expect(metaWritten().appDataRemoval).toBeUndefined();
  });
});
