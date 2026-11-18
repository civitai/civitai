import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appAccessRequestNotifications,
  type AppAccessRequestNotificationDetails,
} from '~/server/notifications/app-access-request.notifications';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

const { createNotification } = vi.hoisted(() => ({
  createNotification: vi.fn(async (_data: unknown) => undefined),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification }));

const { notifyAppAccessDecision } = await import('~/server/services/app-access-request-notify');

/**
 * What an Apps access applicant receives when a moderator decides (pure: no DB, no client).
 */

type Def = (typeof appAccessRequestNotifications)['app-access-request-approved'];
const defs = appAccessRequestNotifications as Record<string, Def>;

function msg(type: string, details: AppAccessRequestNotificationDetails) {
  const def = defs[type];
  expect(def, `${type} is not defined`).toBeTruthy();
  const message = def.prepareMessage({ type, details } as Parameters<Def['prepareMessage']>[0]);
  if (!message) throw new Error(`${type} produced no message`);
  return message;
}

describe('app access request notifications — registration', () => {
  it.each(['app-access-request-approved', 'app-access-request-declined'])(
    '%s is in the registry the bell renders from',
    (type) => {
      expect(
        notificationProcessors[type as keyof typeof notificationProcessors],
        `${type} is not registered`
      ).toBeTruthy();
    }
  );
});

describe('app access request notifications — where they point', () => {
  it('approved links to the Developer Terms on /apps/submit', () => {
    expect(msg('app-access-request-approved', { requestId: 31 }).url).toBe('/apps/submit');
  });

  it('declined links back to Build, where a new request can be sent', () => {
    expect(msg('app-access-request-declined', { requestId: 31 }).url).toBe('/apps/build');
  });

  it('a revoke says access was turned off; a refused request says it was not approved', () => {
    const declined = msg('app-access-request-declined', { requestId: 31 }).message;
    const revoked = msg('app-access-request-declined', { requestId: 31, revoked: true }).message;
    expect(revoked).toMatch(/turned off/);
    expect(revoked).not.toMatch(/not approved/);
    expect(declined).toMatch(/not approved/);
    expect(declined).not.toMatch(/turned off/);
  });
});

describe('notifyAppAccessDecision — what it sends', () => {
  beforeEach(() => createNotification.mockClear());

  it('sends the approved type to the applicant, keyed on request and outcome', async () => {
    await notifyAppAccessDecision({
      userId: 812,
      requestId: 31,
      decision: 'approved',
      revoked: false,
    });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith({
      userId: 812,
      category: 'System',
      type: 'app-access-request-approved',
      key: 'app-access-request-approved:31',
      details: { requestId: 31 },
    });
  });

  it('a revoke sends the declined type with revoked set, under a key distinct from the approval', async () => {
    await notifyAppAccessDecision({
      userId: 812,
      requestId: 31,
      decision: 'declined',
      revoked: true,
    });
    expect(createNotification).toHaveBeenCalledWith({
      userId: 812,
      category: 'System',
      type: 'app-access-request-declined',
      key: 'app-access-request-declined:31',
      details: { requestId: 31, revoked: true },
    });
  });

  it('every type it can send is a registered one', async () => {
    for (const decision of ['approved', 'declined'] as const) {
      createNotification.mockClear();
      await notifyAppAccessDecision({ userId: 812, requestId: 31, decision, revoked: false });
      const { type } = createNotification.mock.calls[0][0] as { type: string };
      expect(
        notificationProcessors[type as keyof typeof notificationProcessors],
        type
      ).toBeTruthy();
    }
  });
});
