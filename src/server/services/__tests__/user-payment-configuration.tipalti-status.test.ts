import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { isBlockedTipaltiStatus, TipaltiStatus } from '~/server/common/enums';
import { Tipalti } from '~/server/http/tipalti/tipalti.schema';
import type * as NotificationService from '~/server/services/notification.service';

const { mockCreateNotification } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mockCreateNotification,
}));

// Spelled out rather than referenced through TipaltiStatus on purpose: these are the strings the
// Tipalti webhook sends and the ones already stored. Reaching for the enum here would move both
// sides of every comparison together, so a mis-cased enum would still pass.
const WEBHOOK_STATUS = {
  pendingOnboarding: 'PendingOnboarding',
  active: 'Active',
  blocked: 'Blocked',
  blockedByProvider: 'BlockedByProvider',
} as const;

type WebhookStatus = (typeof WEBHOOK_STATUS)[keyof typeof WEBHOOK_STATUS];

const config = (status: WebhookStatus, paymentsEnabled: boolean) => ({
  userId: 1,
  tipaltiAccountId: 'payee-1',
  tipaltiAccountStatus: status,
  tipaltiPaymentsEnabled: paymentsEnabled,
});

const update = async (args: {
  storedStatus: WebhookStatus;
  storedPayable: boolean;
  incomingStatus: WebhookStatus;
  incomingPayable: boolean;
}) => {
  dbMock.dbWrite.userPaymentConfiguration.findUnique.mockResolvedValue(
    config(args.storedStatus, args.storedPayable)
  );
  dbMock.dbWrite.userPaymentConfiguration.update.mockResolvedValue(
    config(args.incomingStatus, args.incomingPayable)
  );

  const { updateByTipaltiAccount } = await import(
    '~/server/services/user-payment-configuration.service'
  );

  return updateByTipaltiAccount({
    userId: 1,
    // The webhook types eventData as Record<string, any>, so this cast is the real call shape.
    tipaltiAccountStatus: args.incomingStatus as unknown as TipaltiStatus,
    tipaltiPaymentsEnabled: args.incomingPayable,
  });
};

const notificationTypes = () =>
  mockCreateNotification.mock.calls.map(([arg]) => (arg as { type: string }).type);

describe('updateByTipaltiAccount notifications', () => {
  beforeEach(() => {
    mockCreateNotification.mockClear();
  });

  // 🔴 The regression this guards: TipaltiStatus.Active used to be 'ACTIVE' while Tipalti stores
  // 'Active', so this comparison could never be true and the notification fired on EVERY payable
  // webhook for the creators who were already payable.
  it('does not re-notify an account that was already active and payable', async () => {
    await update({
      storedStatus: WEBHOOK_STATUS.active,
      storedPayable: true,
      incomingStatus: WEBHOOK_STATUS.active,
      incomingPayable: true,
    });

    expect(notificationTypes()).not.toContain('creators-program-payments-enabled');
  });

  it('notifies on the transition into payable', async () => {
    await update({
      storedStatus: WEBHOOK_STATUS.pendingOnboarding,
      storedPayable: false,
      incomingStatus: WEBHOOK_STATUS.active,
      incomingPayable: true,
    });

    expect(notificationTypes()).toContain('creators-program-payments-enabled');
  });

  // A failed payment makes Tipalti mark an otherwise-Active payee unpayable; the account stays
  // 'Active' throughout, so a guard reading status alone never sees the recovery.
  it('notifies when an already-active account becomes payable again', async () => {
    await update({
      storedStatus: WEBHOOK_STATUS.active,
      storedPayable: false,
      incomingStatus: WEBHOOK_STATUS.active,
      incomingPayable: true,
    });

    expect(notificationTypes()).toContain('creators-program-payments-enabled');
  });

  it('does not re-notify a payable account whose status is not Active', async () => {
    await update({
      storedStatus: WEBHOOK_STATUS.pendingOnboarding,
      storedPayable: true,
      incomingStatus: WEBHOOK_STATUS.pendingOnboarding,
      incomingPayable: true,
    });

    expect(notificationTypes()).not.toContain('creators-program-payments-enabled');
  });

  it.each([WEBHOOK_STATUS.blocked, WEBHOOK_STATUS.blockedByProvider])(
    'notifies rejection for %s',
    async (incomingStatus) => {
      await update({
        storedStatus: WEBHOOK_STATUS.active,
        storedPayable: true,
        incomingStatus,
        incomingPayable: false,
      });

      expect(notificationTypes()).toContain('creators-program-rejected-tipalti');
    }
  );

  it('does not re-notify rejection for an account that was already blocked', async () => {
    await update({
      storedStatus: WEBHOOK_STATUS.blocked,
      storedPayable: false,
      incomingStatus: WEBHOOK_STATUS.blockedByProvider,
      incomingPayable: false,
    });

    expect(notificationTypes()).not.toContain('creators-program-rejected-tipalti');
  });
});

// The enum is a contract with an external system rather than a naming choice: it is what incoming
// statuses are parsed against, and what 379 already-stored rows hold. Pinning the strings makes a
// "tidy up the casing" edit fail here instead of silently disabling every comparison against them.
describe('TipaltiStatus', () => {
  it('matches the values Tipalti sends', () => {
    expect({ ...TipaltiStatus }).toEqual({
      PendingOnboarding: 'PendingOnboarding',
      Active: 'Active',
      Suspended: 'Suspended',
      Blocked: 'Blocked',
      BlockedByProvider: 'BlockedByProvider',
      InternalValue: 'INTERNAL_VALUE',
    });
  });
});

describe('payeeStatusSchema', () => {
  it.each(Object.values(TipaltiStatus))('passes %s through unchanged', (status) => {
    expect(Tipalti.payeeStatusSchema.parse(status)).toBe(status);
  });

  // The uppercased spellings the enum used to carry. Coercing them rather than storing them keeps
  // a value that no comparison can match out of the column.
  it.each(['ACTIVE', 'BLOCKED_BY_TIPALTI', 'SomethingTipaltiAddedLater', null, undefined])(
    'coerces the unlisted %s to INTERNAL_VALUE',
    (status) => {
      expect(Tipalti.payeeStatusSchema.parse(status)).toBe(TipaltiStatus.InternalValue);
    }
  );
});

describe('isBlockedTipaltiStatus', () => {
  it.each([TipaltiStatus.Blocked, TipaltiStatus.BlockedByProvider])('is true for %s', (status) => {
    expect(isBlockedTipaltiStatus(status)).toBe(true);
  });

  it.each([
    TipaltiStatus.Active,
    TipaltiStatus.PendingOnboarding,
    TipaltiStatus.Suspended,
    TipaltiStatus.InternalValue,
    'BLOCKED',
    null,
    undefined,
  ])('is false for %s', (status) => {
    expect(isBlockedTipaltiStatus(status)).toBe(false);
  });
});
