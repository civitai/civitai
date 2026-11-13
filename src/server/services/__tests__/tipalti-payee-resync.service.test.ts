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
import type * as NotificationService from '~/server/services/notification.service';

const { getPayeeByRefCode, bust } = vi.hoisted(() => ({
  getPayeeByRefCode: vi.fn(),
  bust: vi.fn().mockResolvedValue(undefined),
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
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

const USER_ID = 1269;
const PAYEE_ID = 'payee-abc';

const stored = (paymentsEnabled: boolean, status = 'Active') => ({
  userId: USER_ID,
  tipaltiAccountId: PAYEE_ID,
  tipaltiAccountStatus: status,
  tipaltiPaymentsEnabled: paymentsEnabled,
});

const payee = (overrides: Record<string, unknown> = {}) => ({
  id: PAYEE_ID,
  refCode: String(USER_ID),
  status: 'Active',
  isPayable: true,
  lastChangeDateTimeUTC: '2026-07-04T23:18:00Z',
  ...overrides,
});

function arrange(storedRow: ReturnType<typeof stored>, tipaltiPayee: unknown) {
  dbMock.dbWrite.userPaymentConfiguration.findUnique.mockResolvedValue(storedRow);
  dbMock.dbWrite.userPaymentConfiguration.update.mockImplementation(async ({ data }) => ({
    ...storedRow,
    ...data,
  }));
  getPayeeByRefCode.mockResolvedValue(tipaltiPayee);
}

const run = (dryRun: boolean) => resyncTipaltiPayees({ userIds: [USER_ID], dryRun, actorId: 1 });

describe('resyncTipaltiPayees', () => {
  beforeEach(() => {
    getPayeeByRefCode.mockReset();
    bust.mockClear();
    dbMock.dbWrite.userPaymentConfiguration.findUnique.mockReset();
    dbMock.dbWrite.userPaymentConfiguration.update.mockReset();
  });

  it('dry run reports a payable payee as an enable and writes nothing', async () => {
    arrange(stored(false), payee());

    const [row] = await run(true);

    expect(row).toMatchObject({ wouldChange: true, direction: 'enable', applied: false });
    expect(row.refused).toBeNull();
    expect(dbMock.dbWrite.userPaymentConfiguration.update).not.toHaveBeenCalled();
    expect(bust).not.toHaveBeenCalled();
  });

  it('dryRun=false writes the flag from Tipalti and busts the cash cache', async () => {
    arrange(stored(false), payee());

    const [row] = await run(false);

    expect(row).toMatchObject({ applied: true, direction: 'enable' });
    expect(dbMock.dbWrite.userPaymentConfiguration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_ID }),
        data: expect.objectContaining({ tipaltiPaymentsEnabled: true }),
      })
    );
    expect(bust).toHaveBeenCalledWith(USER_ID);
  });

  it('applies true -> false too, and labels it a disable', async () => {
    arrange(
      stored(true),
      payee({ isPayable: false, unpayableReasons: ['Certificate has expired.'] })
    );

    const [row] = await run(false);

    expect(row).toMatchObject({ applied: true, direction: 'disable' });
    expect(row.tipalti?.unpayableReasons).toEqual(['Certificate has expired.']);
    expect(dbMock.dbWrite.userPaymentConfiguration.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tipaltiPaymentsEnabled: false }) })
    );
  });

  it('does not write when Tipalti already agrees', async () => {
    arrange(stored(true), payee());

    const [row] = await run(false);

    expect(row).toMatchObject({ wouldChange: false, applied: false, direction: null });
    expect(dbMock.dbWrite.userPaymentConfiguration.update).not.toHaveBeenCalled();
  });

  it.each([
    ['a payee id that is not the stored one', payee({ id: 'someone-else' })],
    ['a refCode that is not this user', payee({ refCode: '999' })],
    ['a payee with no isPayable', payee({ isPayable: undefined })],
    ['a status we do not recognise', payee({ status: 'SomethingNew' })],
    ['no payee at all', null],
  ])('refuses to write for %s', async (_label, tipaltiPayee) => {
    arrange(stored(true), tipaltiPayee);

    const [row] = await run(false);

    expect(row.refused).toEqual(expect.any(String));
    expect(row.applied).toBe(false);
    expect(dbMock.dbWrite.userPaymentConfiguration.update).not.toHaveBeenCalled();
    expect(bust).not.toHaveBeenCalled();
  });

  it('refuses a user with no Tipalti account without calling Tipalti', async () => {
    dbMock.dbWrite.userPaymentConfiguration.findUnique.mockResolvedValue(null);

    const [row] = await run(false);

    expect(row.refused).toEqual(expect.any(String));
    expect(getPayeeByRefCode).not.toHaveBeenCalled();
  });
});

describe('parseResyncUserIds', () => {
  it('parses a comma list', () => {
    expect(parseResyncUserIds('1, 22,333')).toEqual({ userIds: [1, 22, 333] });
  });

  it.each([
    ['a non-numeric id', '1,abc'],
    ['a duplicate id', '5,5'],
    ['an empty entry', '1,,2'],
    ['zero', '0'],
    ['a missing value', undefined],
    [
      'more than the cap',
      Array.from({ length: TIPALTI_RESYNC_MAX_USERS + 1 }, (_, i) => i + 1).join(','),
    ],
  ])('refuses %s', (_label, raw) => {
    expect(parseResyncUserIds(raw)).toEqual({ error: expect.any(String) });
  });
});
