import type { NextApiRequest } from 'next';
import { describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { SessionUser } from '~/types/session';

const flags = { canViewNsfw: true };
vi.mock('~/server/services/feature-flags.service', () => ({ getFeatureFlags: () => flags }));

const { viewerEffectiveBrowsingLevel } = await import(
  '~/server/services/blocks/viewer-browsing-level'
);

const req = {} as NextApiRequest;
const user = (browsingLevel: number) =>
  ({ id: 1, showNsfw: true, browsingLevel } as unknown as SessionUser);

describe('viewerEffectiveBrowsingLevel (the minted viewerBrowsingLevel claim)', () => {
  it('🔴 is the viewer’s own level, not the domain ceiling', () => {
    expect(
      viewerEffectiveBrowsingLevel({
        req,
        sessionUser: user(NsfwLevel.PG),
        maxBrowsingLevel: allBrowsingLevelsFlag,
      })
    ).toBe(NsfwLevel.PG);
  });

  it('🔴 never exceeds the domain ceiling, whatever the viewer saved', () => {
    const level = viewerEffectiveBrowsingLevel({
      req,
      sessionUser: user(allBrowsingLevelsFlag),
      maxBrowsingLevel: sfwBrowsingLevelsFlag,
    });
    expect(level & ~sfwBrowsingLevelsFlag).toBe(0);
    expect(level).not.toBe(0);
  });

  it('CONTROL: an all-levels viewer on an all-levels domain keeps mature levels', () => {
    const level = viewerEffectiveBrowsingLevel({
      req,
      sessionUser: user(allBrowsingLevelsFlag),
      maxBrowsingLevel: allBrowsingLevelsFlag,
    });
    expect(level & NsfwLevel.X).toBe(NsfwLevel.X);
  });

  it('a viewer with no session gets no mature level', () => {
    const level = viewerEffectiveBrowsingLevel({
      req,
      sessionUser: undefined,
      maxBrowsingLevel: allBrowsingLevelsFlag,
    });
    expect(level & ~sfwBrowsingLevelsFlag).toBe(0);
  });
});
