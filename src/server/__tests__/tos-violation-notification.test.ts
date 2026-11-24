import { describe, expect, it } from 'vitest';
import { systemNotifications } from '~/server/notifications/system.notifications';

/**
 * The owner's ToS removal notice. A song and its cover are removed apart (Music T10 item 2,
 * docs/features/music.md "Moderating songs"), so each says which was removed; an image's wording is
 * unchanged.
 */

const message = (details: Record<string, unknown>) =>
  systemNotifications['tos-violation'].prepareMessage({ details } as never);

describe('the tos-violation notice', () => {
  it('reads as before for an image, with and without a reason', () => {
    expect(
      message({ entity: 'image', modelName: 'post #9', url: '/images/30', reason: 'Gore' })
    ).toEqual({
      message: 'Your image on "post #9" has been removed for a Terms of Service violation: Gore.',
      url: '/images/30',
    });
    expect(message({ entity: 'image', modelName: 'post #9', url: '/images/30' })).toEqual({
      message: 'Your image on "post #9" has been removed due to a Terms of Service violation.',
      url: '/images/30',
    });
  });

  it('names a removed song by its title', () => {
    expect(
      message({ entity: 'song', modelName: 'Night drive', url: '/images/20', reason: 'Gore' })
    ).toEqual({
      message: 'Your song "Night drive" has been removed for a Terms of Service violation: Gore.',
      url: '/images/20',
    });
  });

  it("names a removed cover as the song's cover, linking to the song", () => {
    expect(message({ entity: 'song cover', modelName: 'Night drive', url: '/images/20' })).toEqual({
      message:
        'The cover of your song "Night drive" has been removed due to a Terms of Service violation.',
      url: '/images/20',
    });
  });

  it('drops the title of an untitled song', () => {
    expect(message({ entity: 'song', modelName: '', url: '/images/21' })?.message).toBe(
      'Your song has been removed due to a Terms of Service violation.'
    );
    expect(message({ entity: 'song cover', modelName: '', url: '/images/21' })?.message).toBe(
      'The cover of your song has been removed due to a Terms of Service violation.'
    );
  });
});
