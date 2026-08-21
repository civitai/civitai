import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { parseTipaltiStatus, TipaltiStatus } from '~/server/common/enums';
import type * as EmailTemplates from '~/server/email/templates';
import type * as NotificationService from '~/server/services/notification.service';

const { mockCreateNotification, mockTaxFormEmailSend } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn().mockResolvedValue(undefined),
  mockTaxFormEmailSend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/email/templates', async (importOriginal) => ({
  ...(await importOriginal<typeof EmailTemplates>()),
  tipaltiTaxFormRequiredEmail: { send: mockTaxFormEmailSend },
}));

import { updateByTipaltiAccount } from '~/server/services/user-payment-configuration.service';

const userId = 1234;

/** The row as it exists BEFORE the webhook's update lands. */
function existingConfig(overrides: Record<string, unknown> = {}) {
  return {
    userId,
    tipaltiAccountId: 'payee-1',
    tipaltiAccountStatus: 'Active',
    tipaltiPaymentsEnabled: true,
    ...overrides,
  };
}

function notificationsOfType(type: string) {
  return mockCreateNotification.mock.calls
    .map(([row]) => row as { type: string; key: string })
    .filter((row) => row.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.userPaymentConfiguration.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ ...existingConfig(), ...data })
  );
  dbMock.dbRead.user.findUnique.mockResolvedValue(null);
});

describe('parseTipaltiStatus', () => {
  it('maps every spelling observed in production', () => {
    expect(parseTipaltiStatus('Active')).toBe(TipaltiStatus.Active);
    expect(parseTipaltiStatus('PendingOnboarding')).toBe(TipaltiStatus.PendingOnboarding);
    expect(parseTipaltiStatus('Blocked')).toBe(TipaltiStatus.Blocked);
    expect(parseTipaltiStatus('BlockedByProvider')).toBe(TipaltiStatus.BlockedByProvider);
    expect(parseTipaltiStatus('INTERNAL_VALUE')).toBe(TipaltiStatus.InternalValue);
  });

  it('matches case-insensitively so historic rows still resolve', () => {
    expect(parseTipaltiStatus('ACTIVE')).toBe(TipaltiStatus.Active);
    expect(parseTipaltiStatus('BLOCKED')).toBe(TipaltiStatus.Blocked);
  });

  it('returns null for a status we do not model, and for empty input', () => {
    expect(parseTipaltiStatus('BlockedBySomeoneNew')).toBeNull();
    expect(parseTipaltiStatus('')).toBeNull();
    expect(parseTipaltiStatus(undefined)).toBeNull();
  });
});

describe('updateByTipaltiAccount — creators-program-payments-enabled', () => {
  it('does not notify when the account was already payable', async () => {
    dbMock.dbWrite.userPaymentConfiguration.findUnique.mockResolvedValue(existingConfig());

    await updateByTipaltiAccount({
      userId,
      tipaltiAccountStatus: 'Active',
      tipaltiPaymentsEnabled: true,
    });

    expect(notificationsOfType('creators-program-payments-enabled')).toHaveLength(0);
  });

  it('stays silent across repeated payable webhooks', async () => {
    dbMock.dbWrite.userPaymentConfiguration.findUnique.mockResolvedValue(existingConfig());

    for (let i = 0; i < 3; i++) {
      await updateByTipaltiAccount({
        userId,
        tipaltiAccountStatus: 'Active',
        tipaltiPaymentsEnabled: true,
      });
    }

    expect(notificationsOfType('creators-program-payments-enabled')).toHaveLength(0);
  });

  it('notifies once on the not-payable -> payable edge, under a key stable per user', async () => {
    dbMock.dbWrite.userPaymentConfiguration.findUnique.mockResolvedValue(
      existingConfig({ tipaltiAccountStatus: 'PendingOnboarding', tipaltiPaymentsEnabled: false })
    );

    await updateByTipaltiAccount({
      userId,
      tipaltiAccountStatus: 'Active',
      tipaltiPaymentsEnabled: true,
    });

    const sent = notificationsOfType('creators-program-payments-enabled');
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toBe(`creators-program-payments-enabled:${userId}`);
  });
});

describe('updateByTipaltiAccount — creators-program-rejected-tipalti', () => {
  it.each([['Blocked'], ['BlockedByProvider']])(
    'notifies on the %s status Tipalti actually sends',
    async (status) => {
      dbMock.dbWrite.userPaymentConfiguration.findUnique.mockResolvedValue(existingConfig());

      await updateByTipaltiAccount({
        userId,
        tipaltiAccountStatus: status,
        tipaltiPaymentsEnabled: false,
      });

      const sent = notificationsOfType('creators-program-rejected-tipalti');
      expect(sent).toHaveLength(1);
      expect(sent[0].key).toBe(`creators-program-rejected-tipalti:${userId}`);
    }
  );

  it('does not notify when the account is merely not payable', async () => {
    dbMock.dbWrite.userPaymentConfiguration.findUnique.mockResolvedValue(existingConfig());

    await updateByTipaltiAccount({
      userId,
      tipaltiAccountStatus: 'Active',
      tipaltiPaymentsEnabled: false,
    });

    expect(notificationsOfType('creators-program-rejected-tipalti')).toHaveLength(0);
  });

  it("stores Tipalti's spelling verbatim rather than a normalized member", async () => {
    dbMock.dbWrite.userPaymentConfiguration.findUnique.mockResolvedValue(existingConfig());

    await updateByTipaltiAccount({
      userId,
      tipaltiAccountStatus: 'BlockedByProvider',
      tipaltiPaymentsEnabled: false,
    });

    const lastUpdate = dbMock.dbWrite.userPaymentConfiguration.update.mock.calls.at(-1) as [
      { data: Record<string, unknown> }
    ];
    expect(lastUpdate[0].data.tipaltiAccountStatus).toBe('BlockedByProvider');
  });
});
