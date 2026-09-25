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
});

describe('entity-appeal-resolved — Void', () => {
  it('says the appeal was closed because the content is gone, not that it was decided', () => {
    const m = prepare({ entityType: EntityType.Image, entityId: 99, status: AppealStatus.Void });

    expect(m!.message).toMatch(/closed because the image no longer exists/i);
    expect(m!.message).not.toMatch(/has been void/i);
  });

  it('tells the user their fee was refunded when it was', () => {
    const m = prepare({
      entityType: EntityType.Image,
      entityId: 99,
      status: AppealStatus.Void,
      refunded: true,
    });

    expect(m!.message).toMatch(/appeal fee has been refunded/i);
  });

  it('does not mention a refund when there was no fee', () => {
    const m = prepare({ entityType: EntityType.Image, entityId: 99, status: AppealStatus.Void });

    expect(m!.message).not.toMatch(/refund/i);
  });

  it('does not link to content that no longer exists', () => {
    const m = prepare({ entityType: EntityType.Model, entityId: 5, status: AppealStatus.Void });

    expect(m!.url).toBeUndefined();
  });
});
