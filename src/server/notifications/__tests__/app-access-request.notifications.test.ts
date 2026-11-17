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
 *
 * The copy is pinned as whole strings: the artifact is prose, and a keyword check stays green
 * through a rewrite that drops the next step. A reword fails here on purpose.
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
    '%s is in the registry the bell renders from, as a non-toggleable System type',
    (type) => {
      const def = notificationProcessors[type as keyof typeof notificationProcessors];
      expect(def, `${type} is not registered`).toBeTruthy();
      expect(def.category).toBe('System');
      expect(def.toggleable).toBe(false);
      expect((def as { prepareQuery?: unknown }).prepareQuery).toBeUndefined();
      // Onsite only: email is opted into per type and these are not.
      expect((def as { defaultEmail?: boolean }).defaultEmail).toBeFalsy();
    }
  );
});

describe('app access request notifications — what the applicant reads', () => {
  it('approved: author access is on, and it links to the Developer Terms on /apps/submit', () => {
    expect(msg('app-access-request-approved', { requestId: 31 })).toEqual({
      message:
        'Your request to build apps was approved and author access is on. Accept the App Developer Terms, then open Build to start your first app.',
      url: '/apps/submit',
    });
  });

  it('declined: neutral, links back to Build where a new request can be sent', () => {
    expect(msg('app-access-request-declined', { requestId: 31 })).toEqual({
      message:
        'Your request to build apps was not approved this time. You can send a new request from Build.',
      url: '/apps/build',
    });
  });

  it('a revoke says access was turned off, not that a request was refused', () => {
    expect(msg('app-access-request-declined', { requestId: 31, revoked: true })).toEqual({
      message:
        'Your access to build apps has been turned off. You can send a new request from Build.',
      url: '/apps/build',
    });
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
