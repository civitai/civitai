import { describe, expect, it } from 'vitest';
import { reportNotifications } from '~/server/notifications/report.notifications';
import { EntityType } from '~/shared/utils/prisma/enums';

type Def = (typeof reportNotifications)['entity-appeal-content-removed'];
const def = (reportNotifications as Record<string, Def>)['entity-appeal-content-removed'];

const prepare = (details: MixedObject) =>
  def.prepareMessage({ type: 'entity-appeal-content-removed', details } as Parameters<
    Def['prepareMessage']
  >[0]);

const base = { entityType: EntityType.Image, entityId: 7 };

describe('entity-appeal-content-removed — prepareMessage', () => {
  it('tells an appellant whose content was removed that the appeal is still open', () => {
    const m = prepare({ ...base, outcome: 'under-review', refunded: false });

    expect(m!.message).toBe(
      "The image you appealed was removed before a moderator could review it. Your appeal is still open and will be reviewed; we'll let you know the outcome."
    );
    expect(m!.url).toBeUndefined();
  });

  it('mentions the refund on an owner-deleted close only when one was made', () => {
    expect(prepare({ ...base, outcome: 'closed-owner-deleted', refunded: true })!.message).toBe(
      'Your appeal was closed because you deleted the image. Your appeal fee has been refunded.'
    );
    expect(prepare({ ...base, outcome: 'closed-owner-deleted', refunded: false })!.message).toBe(
      'Your appeal was closed because you deleted the image.'
    );
  });

  it('explains an appeal closed unreviewed and offers a re-upload', () => {
    const m = prepare({
      entityType: EntityType.Model,
      entityId: 3,
      outcome: 'closed-unreviewed',
      refunded: true,
    });

    expect(m!.message).toBe(
      "We couldn't review your appeal in time: the model was removed before a moderator reached it, so your appeal was closed. Your appeal fee has been refunded. You're welcome to upload it again."
    );
  });
});
