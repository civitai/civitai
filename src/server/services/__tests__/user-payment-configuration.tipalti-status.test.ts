import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TipaltiStatus } from '~/server/common/enums';
import type * as NotificationService from '~/server/services/notification.service';

const { mockCreateNotification } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mockCreateNotification,
}));

// Spelled out rather than referenced through TipaltiStatus on purpose: these are the strings the
// Tipalti webhook sends and stores verbatim. Reaching for the enum here would move both sides of
// every comparison together, so a mis-cased enum would still pass.
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

  // 🔴 The incident: this branch compared the stored status against TipaltiStatus.Active, which was
  // spelled 'ACTIVE' while Tipalti stores 'Active'. Never true, so every payable webhook re-notified
  // all 291 payable creators. The enum casing is pinned below; this asserts the branch itself.
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

  // Tipalti sends payeeDetailsChanged for edits that move nothing (a new address, a new payment
  // method), so "already payable, still payable" is the ordinary repeat delivery, not an edge case.
  it('does not re-notify a payable account whose status is not literally Active', async () => {
    await update({
      storedStatus: WEBHOOK_STATUS.pendingOnboarding,
      storedPayable: true,
      incomingStatus: WEBHOOK_STATUS.pendingOnboarding,
      incomingPayable: true,
    });

    expect(notificationTypes()).not.toContain('creators-program-payments-enabled');
  });

  // The tax-form path below this branch takes payable -> unpayable at an unchanged Active status;
  // resolving the form is the same move back, and a status comparison cannot see either one.
  it('notifies when payability is restored without the status changing', async () => {
    await update({
      storedStatus: WEBHOOK_STATUS.active,
      storedPayable: false,
      incomingStatus: WEBHOOK_STATUS.active,
      incomingPayable: true,
    });

    expect(notificationTypes()).toContain('creators-program-payments-enabled');
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

  it.each([
    [WEBHOOK_STATUS.blocked, WEBHOOK_STATUS.blocked],
    [WEBHOOK_STATUS.blocked, WEBHOOK_STATUS.blockedByProvider],
    [WEBHOOK_STATUS.blockedByProvider, WEBHOOK_STATUS.blocked],
  ])('does not re-notify rejection for %s -> %s', async (storedStatus, incomingStatus) => {
    await update({
      storedStatus,
      storedPayable: false,
      incomingStatus,
      incomingPayable: false,
    });

    expect(notificationTypes()).not.toContain('creators-program-rejected-tipalti');
  });
});

// The webhook writes Tipalti's `eventData.status` verbatim, so the enum is a contract with an
// external system rather than a naming choice. Pinning the strings makes a "tidy up the casing"
// edit fail here instead of silently disabling every comparison against them.
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
