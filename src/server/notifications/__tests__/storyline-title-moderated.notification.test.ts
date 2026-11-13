import { describe, expect, it } from 'vitest';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import { NsfwLevel } from '~/server/common/enums';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

const processor = notificationProcessors['storyline-title-moderated'];
const render = (details: Record<string, unknown>) => processor.prepareMessage({ details } as never);

describe('storyline-title-moderated', () => {
  it('is registered as a toggleable Moderation notification', () => {
    expect(processor.toggleable).not.toBe(false);
    expect(processor.category).toBe('Moderation');
  });

  it('names the rating and how to have the title checked again', () => {
    expect(render({ storylineId: 10, title: 'Dark Road', level: NsfwLevel.R })).toEqual({
      message:
        'Your storyline "Dark Road" is now rated R because of its title, so only readers who browse at that level see it. Edit the title to have it checked again.',
      url: storylineUrl(10),
    });
  });

  it('says the storyline is hidden when it was taken down', () => {
    expect(render({ storylineId: 10, title: 'Dark Road', takenDown: true })).toEqual({
      message:
        'Your storyline "Dark Road" is hidden from other readers because of its title. Edit the title to have it checked again.',
      url: storylineUrl(10),
    });
  });

  it('says chapters are held to safe for work when the title is about a minor', () => {
    expect(render({ storylineId: 10, title: 'Dark Road', minor: true })).toEqual({
      message:
        'Your storyline "Dark Road" can only hold safe-for-work chapters because of its title: chapters rated above PG-13 are hidden and new ones are refused. Edit the title to have it checked again.',
      url: storylineUrl(10),
    });
  });
});
