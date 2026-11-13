import { describe, expect, it } from 'vitest';
import { isComSafeLevel, leadComCoverBlurred } from '../com-face';

describe('isComSafeLevel', () => {
  it('takes PG and PG-13 only: unrated and R or above are not what civitai.com shows', () => {
    expect([0, 1, 2, 4, 8, 16].map(isComSafeLevel)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('leadComCoverBlurred', () => {
  const cover = (nsfwLevel: number) => ({ id: 1, url: 'u', type: 'image' as const, nsfwLevel });
  const lead = (modelId: number, restriction: string, nsfwLevel: number | null) => ({
    modelId,
    restriction,
    comFace: {
      name: 'n',
      url: 'x',
      cover: nsfwLevel == null ? null : cover(nsfwLevel),
      coverPicked: nsfwLevel != null,
    },
  });
  const none = new Set<number>();

  it('hides the cover on a minor lead, even a PG one', () => {
    expect(leadComCoverBlurred(lead(1, 'minor', 1), none)).toBe(true);
  });
  it('hides an R cover on a real-person lead', () => {
    expect(leadComCoverBlurred(lead(1, 'poi', 4), none)).toBe(true);
  });
  it('shows a PG cover on a real-person lead', () => {
    expect(leadComCoverBlurred(lead(1, 'poi', 1), none)).toBe(false);
  });
  it('reveals only the row the moderator revealed', () => {
    const revealed = new Set([1]);
    expect(leadComCoverBlurred(lead(1, 'minor', 1), revealed)).toBe(false);
    expect(leadComCoverBlurred(lead(2, 'minor', 1), revealed)).toBe(true);
  });
  it('has nothing to hide without a cover', () => {
    expect(leadComCoverBlurred(lead(1, 'minor', null), none)).toBe(false);
  });
});
