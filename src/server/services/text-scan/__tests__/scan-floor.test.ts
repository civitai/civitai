import { describe, expect, it } from 'vitest';
import {
  articleModerationFloorText,
  ratedEntityDerivedNsfwLevelText,
} from '@civitai/shared/rated-entity-sql';
import {
  articleModerationFloorSql,
  ratedEntityDerivedNsfwLevelSql,
} from '~/server/services/text-scan/scan-floor';

describe('main-app floor fragments', () => {
  it('render the shared text verbatim, with no bound values', () => {
    const floor = articleModerationFloorSql('a.id');
    expect(floor.text).toBe(articleModerationFloorText('a.id'));
    expect(floor.values).toEqual([]);
    expect(ratedEntityDerivedNsfwLevelSql('Post', 'p').text).toBe(
      ratedEntityDerivedNsfwLevelText('Post', 'p')
    );
  });
});
