import { describe, expect, it } from 'vitest';
import { reportNotifications } from '~/server/notifications/report.notifications';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

type Def = (typeof reportNotifications)['entity-appeal-resolved'];
const def = (reportNotifications as Record<string, Def>)['entity-appeal-resolved'];

const prepare = (details: MixedObject) =>
  def.prepareMessage({ type: 'entity-appeal-resolved', details } as Parameters<
    Def['prepareMessage']
  >[0]);

describe('entity-appeal-resolved — prepareMessage url', () => {
  // The email deliberately omits `resolvedMessage`, so this notification is the
  // owner's only route back to the decision.
  it('links a resolved Model appeal to the model', () => {
    const m = prepare({
      entityType: EntityType.Model,
      entityId: 2186217,
      status: AppealStatus.Rejected,
    });

    expect(m!.url).toBe('/models/2186217');
  });

  it('still links a resolved Image appeal to the image', () => {
    const m = prepare({
      entityType: EntityType.Image,
      entityId: 99,
      status: AppealStatus.Approved,
    });

    expect(m!.url).toBe('/images/99');
  });

  it('links a resolved Bounty appeal to the bounty, not undefined/<id>', () => {
    const m = prepare({
      entityType: EntityType.Bounty,
      entityId: 9,
      status: AppealStatus.Approved,
    });
    expect(m!.url).toBe('/bounties/9');
  });
});

// Sent by the moderator app's site-appeal queues, which add `category`.
describe('entity-appeal-resolved — site appeal form', () => {
  it('says the article was restored, and links to it, only when it was', () => {
    const restored = prepare({
      category: 'Article',
      entityType: EntityType.Article,
      entityId: 5,
      status: AppealStatus.Approved,
      restored: true,
      resolvedMessage: '',
    });
    expect(restored).toEqual({
      message: 'We reviewed your appeal and restored your article.',
      url: '/articles/5',
    });

    const gone = prepare({
      category: 'Article',
      entityType: EntityType.Article,
      entityId: 5,
      status: AppealStatus.Approved,
      restored: false,
    });
    expect(gone).toEqual({ message: 'We reviewed your appeal and approved it.', url: '/appeal' });
  });

  it('links an account appeal to the appeal page, never to a user id path', () => {
    const m = prepare({
      category: 'Account',
      entityType: EntityType.User,
      entityId: 77,
      status: AppealStatus.Rejected,
      restored: false,
      resolvedMessage: 'The ban stands.',
    });
    expect(m).toEqual({
      message:
        "We reviewed your appeal. The decision on your account stands. Moderator's note: The ban stands.",
      url: '/appeal',
    });
  });

  it('leaves an in-app appeal on the original copy', () => {
    const m = prepare({ entityType: EntityType.Model, entityId: 3, status: AppealStatus.Approved });
    expect(m).toEqual({
      message: 'Your appeal regarding your Model has been approved.',
      url: '/models/3',
    });
  });
});
