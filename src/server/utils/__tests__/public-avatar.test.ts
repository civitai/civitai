import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { avatarAtLevel } from '~/server/utils/public-avatar';

const { PG, PG13, R } = NsfwLevel;

describe('avatarAtLevel', () => {
  it.each([
    ['a PG picture at PG', PG, publicBrowsingLevelsFlag, true],
    ['a PG13 picture at PG|PG13', PG13, sfwBrowsingLevelsFlag, true],
    ['a PG13 picture at PG', PG13, publicBrowsingLevelsFlag, false],
    ['an unrated picture', 0, sfwBrowsingLevelsFlag, false],
    ['a PG|R picture at PG|PG13', PG | R, sfwBrowsingLevelsFlag, false],
  ])('%s', (_label, nsfwLevel, level, shown) => {
    const picture = { url: 'avatar.png', nsfwLevel };
    expect(avatarAtLevel(picture, level)).toBe(shown ? picture : null);
  });

  it('serves nothing without a picture', () => {
    expect(avatarAtLevel(null, sfwBrowsingLevelsFlag)).toBeNull();
  });
});
