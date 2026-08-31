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
