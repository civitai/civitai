import { describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';

const { mockHeldLevelsByPost } = vi.hoisted(() => ({ mockHeldLevelsByPost: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({
  getHeldLevelsByPost: mockHeldLevelsByPost,
}));

const { getCoverBrowsingLevels } = await import('~/server/utils/public-cover-image');

const HELD_POST = 1;
const UNHELD_POST = 2;
const MATURE = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R | NsfwLevel.X;

describe('getCoverBrowsingLevels', () => {
  it("judges a cover on a held model's post at the viewer's level within the model's gallery level", async () => {
    mockHeldLevelsByPost.mockResolvedValue(new Map([[HELD_POST, { level: NsfwLevel.PG }]]));
    const levelOf = await getCoverBrowsingLevels(
      [{ postId: HELD_POST }, { postId: UNHELD_POST }, { postId: null }, null],
      MATURE
    );

    expect(levelOf({ postId: HELD_POST })).toBe(NsfwLevel.PG);
    expect(levelOf({ postId: UNHELD_POST })).toBe(MATURE);
    expect(levelOf({ postId: null })).toBe(MATURE);
    expect(levelOf(null)).toBe(MATURE);
    expect(mockHeldLevelsByPost).toHaveBeenCalledWith([HELD_POST, UNHELD_POST], {
      withOwners: false,
    });
  });

  it('allows nothing when the gallery level and the viewer level share no rating', async () => {
    mockHeldLevelsByPost.mockResolvedValue(new Map([[HELD_POST, { level: NsfwLevel.PG }]]));
    const levelOf = await getCoverBrowsingLevels([{ postId: HELD_POST }], NsfwLevel.R);
    expect(levelOf({ postId: HELD_POST })).toBe(0);
  });
});
