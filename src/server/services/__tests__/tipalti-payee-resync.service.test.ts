import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
// Module scope: see the note in user-payment-configuration.tipalti-status.test.ts on why this
// import graph is not loaded from a test body.
import {
  parseResyncUserIds,
  resyncTipaltiPayees,
  TIPALTI_RESYNC_MAX_USERS,
} from '~/server/services/tipalti-payee-resync.service';
import type * as CreatorProgramService from '~/server/services/creator-program.service';
import type * as ModeratorService from '~/server/services/moderator.service';
import type * as NotificationService from '~/server/services/notification.service';

const { getPayeeByRefCode, bust, createNotification, trackModActivity } = vi.hoisted(() => ({
  getPayeeByRefCode: vi.fn(),
  bust: vi.fn(),
  createNotification: vi.fn(),
  trackModActivity: vi.fn(),
}));

vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity,
}));

vi.mock('~/server/http/tipalti/tipalti.caller', () => ({
  default: async () => ({ getPayeeByRefCode }),
}));

vi.mock('~/server/services/creator-program.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorProgramService>()),
  userCashCache: { bust },
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));

const USER_ID = 1269;
const PAYEE_ID = 'payee-abc';

type Stored = {
  userId: number;
  tipaltiAccountId: string;
  tipaltiAccountStatus: string;
  tipaltiPaymentsEnabled: boolean;
};

const stored = (paymentsEnabled: boolean, status = 'Active', userId = USER_ID): Stored => ({
  userId,
  tipaltiAccountId: `${PAYEE_ID}-${userId}`,
  tipaltiAccountStatus: status,
  tipaltiPaymentsEnabled: paymentsEnabled,
});

const payee = (overrides: Record<string, unknown> = {}, userId = USER_ID) => ({
  id: `${PAYEE_ID}-${userId}`,
  refCode: String(userId),
  status: 'Active',
  isPayable: true,
  lastChangeDateTimeUTC: '2026-07-04T23:18:00Z',
  ...overrides,
});

function arrange(storedRow: Stored, tipaltiPayee: unknown) {
  dbMock.dbWrite.userPaymentConfiguration.findUnique.mockResolvedValue(storedRow);
  dbMock.dbWrite.userPaymentConfiguration.updateMany.mockResolvedValue({ count: 1 });
  getPayeeByRefCode.mockResolvedValue(tipaltiPayee);
}

const run = (dryRun: boolean, userIds = [USER_ID]) =>
  resyncTipaltiPayees({ userIds, dryRun, actorId: 1 });

const update = dbMock.dbWrite.userPaymentConfiguration.updateMany;
const writtenData = () => update.mock.calls[0][0].data;

describe('resyncTipaltiPayees', () => {
  beforeEach(() => {
    getPayeeByRefCode.mockReset();
    bust.mockReset().mockResolvedValue(undefined);
    createNotification.mockReset().mockResolvedValue(undefined);
    trackModActivity.mockReset().mockResolvedValue(undefined);
    dbMock.dbWrite.userPaymentConfiguration.findUnique.mockReset();
    update.mockReset();
    dbMock.dbRead.user.findUnique.mockReset();
  });

  it('dry run reports a payable payee as an enable and writes nothing', async () => {
    arrange(stored(false), payee());

    const [row] = await run(true);

    expect(row).toMatchObject({ wouldChange: true, direction: 'enable', applied: false });
    expect(row.refused).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(bust).not.toHaveBeenCalled();
  });

  it('dryRun=false writes the flag from Tipalti, busts the cash cache and tells the user', async () => {
    arrange(stored(false), payee());

    const [row] = await run(false);

    expect(row).toMatchObject({ applied: true, direction: 'enable' });
    // Conditional on the state the comparison used, so a webhook in between wins.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: USER_ID,
          tipaltiAccountId: `${PAYEE_ID}-${USER_ID}`,
          tipaltiAccountStatus: 'Active',
          tipaltiPaymentsEnabled: false,
        },
      })
    );
    expect(trackModActivity).toHaveBeenCalledWith(1, {
      entityType: 'user',
      entityId: USER_ID,
      activity: 'tipaltiResync:enable',
    });
    expect(writtenData()).toMatchObject({
      tipaltiPaymentsEnabled: true,
      tipaltiAccountStatus: 'Active',
    });
    expect(bust).toHaveBeenCalledWith(USER_ID);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, type: 'creators-program-payments-enabled' })
    );
  });

  it('applies true -> false, labels it a disable, and reports but never forwards the reasons', async () => {
    // 'Tax' is the reason updateByTipaltiAccount emails on; it must not reach it from here.
    arrange(stored(true), payee({ isPayable: false, unpayableReasons: ['Tax'] }));

    const [row] = await run(false);

    expect(row).toMatchObject({ applied: true, direction: 'disable' });
    expect(row.tipalti?.unpayableReasons).toEqual(['Tax']);
    expect(writtenData()).toMatchObject({ tipaltiPaymentsEnabled: false });
    expect(dbMock.dbRead.user.findUnique).not.toHaveBeenCalled();
  });

  it('syncs a status-only change and writes the status Tipalti reports', async () => {
    arrange(stored(false, 'Active'), payee({ status: 'Suspended', isPayable: false }));

    const [row] = await run(false);

    expect(row).toMatchObject({ wouldChange: true, direction: null, applied: true });
    expect(writtenData()).toMatchObject({ tipaltiAccountStatus: 'Suspended' });
  });

  it('does not write when Tipalti already agrees', async () => {
    arrange(stored(true), payee());

    const [row] = await run(false);

    expect(row).toMatchObject({ wouldChange: false, applied: false, direction: null });
    expect(update).not.toHaveBeenCalled();
  });

  // Stored false, and every payee below would otherwise enable: only the refusal stops a write.
  it.each([
    ['a payee id that is not the stored one', payee({ id: 'someone-else' }), /payee id/],
    ['a refCode that is not this user', payee({ refCode: '999' }), /refCode/],
    ['a payee with no isPayable', payee({ isPayable: undefined }), /isPayable/],
    ['a status we do not recognise', payee({ status: 'SomethingNew' }), /recognise/],
    ['no payee at all', null, /no payee/],
  ])('refuses to write for %s', async (_label, tipaltiPayee, reason) => {
    arrange(stored(false), tipaltiPayee);

    const [row] = await run(false);

    expect(row.refused).toMatch(reason);
    expect(row.applied).toBe(false);
    if (/refCode|payee id/.test(String(reason))) expect(row.tipalti).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(bust).not.toHaveBeenCalled();
  });

  it('refuses, and tells no one, when a webhook changes the row between the read and the write', async () => {
    // Every read still sees the old row; only the conditional write finds it moved.
    arrange(stored(false), payee());
    update.mockResolvedValue({ count: 0 });

    const [row] = await run(false);

    expect(row).toMatchObject({
      refused: 'Stored state changed during the Tipalti read; re-run',
      applied: false,
    });
    expect(createNotification).not.toHaveBeenCalled();
    expect(trackModActivity).not.toHaveBeenCalled();
    expect(bust).not.toHaveBeenCalled();
  });

  it('a status-only move to Blocked sends the rejection notification', async () => {
    arrange(stored(false, 'Active'), payee({ status: 'Blocked', isPayable: false }));

    const [row] = await run(false);

    expect(row).toMatchObject({ applied: true, direction: null });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, type: 'creators-program-rejected-tipalti' })
    );
  });

  it('notifies against the state the write was conditioned on, not an in-between read', async () => {
    // A webhook flipped the row to true and back to false between the resync's read and the
    // service's own read; the conditional write still lands on false, so this is an enable.
    arrange(stored(false), payee());
    dbMock.dbWrite.userPaymentConfiguration.findUnique
      .mockResolvedValueOnce(stored(false))
      .mockResolvedValueOnce(stored(true));

    const [row] = await run(false);

    expect(row).toMatchObject({ applied: true, direction: 'enable' });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'creators-program-payments-enabled' })
    );
  });

  it('refuses a user with no Tipalti account without calling Tipalti', async () => {
    dbMock.dbWrite.userPaymentConfiguration.findUnique.mockResolvedValue(null);

    const [row] = await run(false);

    expect(row.refused).toMatch(/No Tipalti account/);
    expect(getPayeeByRefCode).not.toHaveBeenCalled();
  });

  it('a failed Tipalti read refuses that user and still processes the next', async () => {
    const other = USER_ID + 1;
    dbMock.dbWrite.userPaymentConfiguration.findUnique.mockImplementation(async ({ where }) =>
      stored(false, 'Active', where.userId)
    );
    update.mockResolvedValue({ count: 1 });
    getPayeeByRefCode
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(payee({}, other));

    const rows = await run(false, [USER_ID, other]);

    expect(rows[0]).toMatchObject({ refused: 'Tipalti read failed', applied: false });
    expect(rows[1]).toMatchObject({ userId: other, applied: true });
    expect(bust).toHaveBeenCalledTimes(1);
    expect(bust).toHaveBeenCalledWith(other);
  });

  it('a failed write reports not applied and does not bust', async () => {
    arrange(stored(false), payee());
    update.mockRejectedValueOnce(new Error('db down'));

    const [row] = await run(false);

    expect(row).toMatchObject({ applied: false, error: 'Write failed' });
    expect(bust).not.toHaveBeenCalled();
  });

  it('a failed cache bust still reports the write as applied', async () => {
    arrange(stored(false), payee());
    bust.mockRejectedValueOnce(new Error('redis down'));

    const [row] = await run(false);

    expect(row).toMatchObject({ applied: true, error: expect.stringMatching(/cache bust/) });
  });
});

describe('parseResyncUserIds', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(',');

  it('parses a comma list, up to the cap', () => {
    expect(parseResyncUserIds('1, 22,333')).toEqual({ userIds: [1, 22, 333] });
    expect(parseResyncUserIds(ids(TIPALTI_RESYNC_MAX_USERS))).toMatchObject({
      userIds: expect.any(Array),
    });
  });

  it.each([
    ['a non-numeric id', '1,abc', /Invalid/],
    ['a trailing letter', '1x', /Invalid/],
    ['a leading zero', '01', /Invalid/],
    ['a negative id', '-1', /Invalid/],
    ['an unsafe integer', '9007199254740993', /Invalid/],
    ['a duplicate id', '5,5', /Duplicate/],
    ['an empty entry', '1,,2', /Invalid/],
    ['zero', '0', /Invalid/],
    ['whitespace only', '  ', /required/],
    ['a repeated query param', ['1', '2'], /required/],
    ['a missing value', undefined, /required/],
    ['more than the cap', ids(TIPALTI_RESYNC_MAX_USERS + 1), /At most/],
  ])('refuses %s', (_label, raw, message) => {
    const result = parseResyncUserIds(raw);
    expect('error' in result && result.error).toMatch(message);
  });
});
