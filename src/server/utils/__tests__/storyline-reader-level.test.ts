import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { storylineReaderLevel } from '~/server/utils/storyline-reader-level';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

type Ctx = Parameters<typeof storylineReaderLevel>[0];

const ctx = ({
  user,
  canViewNsfw,
  isGreen,
}: {
  user?: { id: number; showNsfw?: boolean; browsingLevel?: number };
  canViewNsfw: boolean;
  isGreen: boolean;
}) => ({ user, features: { canViewNsfw, isGreen }, req: { headers: {} } } as unknown as Ctx);

describe('storylineReaderLevel', () => {
  it('holds a signed-out reader to the public level whatever they ask for', () => {
    const level = storylineReaderLevel(
      ctx({ canViewNsfw: true, isGreen: false }),
      allBrowsingLevelsFlag
    );
    expect(level).toBe(publicBrowsingLevelsFlag);
    expect(level & NsfwLevel.X).toBe(0);
  });

  it('holds a signed-in reader on the SFW domain to PG and PG-13', () => {
    const level = storylineReaderLevel(
      ctx({ user: { id: 1 }, canViewNsfw: false, isGreen: true }),
      allBrowsingLevelsFlag
    );
    expect(level).toBe(sfwBrowsingLevelsFlag);
  });

  it('serves what a signed-in reader asked for where mature content is allowed', () => {
    const asked = NsfwLevel.PG | NsfwLevel.R;
    expect(
      storylineReaderLevel(ctx({ user: { id: 1 }, canViewNsfw: true, isGreen: false }), asked)
    ).toBe(asked);
  });

  it('keeps the SFW domain to PG and PG-13 even if the domain cap were bypassed', () => {
    // Inconsistent on purpose: mature content "allowed" on the SFW domain, so the cap is off and
    // only the backstop stands between the request and an X chapter.
    const level = storylineReaderLevel(
      ctx({ user: { id: 1 }, canViewNsfw: true, isGreen: true }),
      allBrowsingLevelsFlag
    );
    expect(level & ~sfwBrowsingLevelsFlag).toBe(0);
  });

  it("uses a signed-in reader's saved level when they sent none", () => {
    const saved = NsfwLevel.PG | NsfwLevel.X;
    expect(
      storylineReaderLevel(
        ctx({
          user: { id: 1, showNsfw: true, browsingLevel: saved },
          canViewNsfw: true,
          isGreen: false,
        }),
        undefined
      )
    ).toBe(saved);
  });
});
