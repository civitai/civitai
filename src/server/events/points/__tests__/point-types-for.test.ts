import { describe, expect, it } from 'vitest';
import '~/__tests__/mocks/db.mock';
import { pointTypesFor } from '~/server/events/points/types';

const { birthday2026 } = await import('~/server/events/birthday2026.event');

describe('pointTypesFor', () => {
  const config = {
    capPerActorPerOwnerPerDay: 50,
    types: {
      view: { weight: 1, once: 'day' as const, entities: ['Image', 'Model', 'Article'] as const },
      reaction: { weight: 5, once: 'event' as const, entities: ['Image', 'Article'] as const },
      modelLike: { weight: 5, once: 'event' as const, entities: ['Model'] as const },
    },
  };

  it('lists the types that score an entity, in the engine order', () => {
    expect(pointTypesFor(config, 'Article')).toEqual(['view', 'reaction']);
    expect(pointTypesFor(config, 'Model')).toEqual(['view', 'modelLike']);
    expect(pointTypesFor({ ...config, types: {} }, 'Image')).toEqual([]);
  });

  // The event page tells players "Articles score views, reactions and comments" from this.
  it('scores birthday 2026 articles by views, reactions and comments', () => {
    expect(pointTypesFor(birthday2026.scoring!, 'Article')).toEqual([
      'view',
      'reaction',
      'comment',
    ]);
  });
});
