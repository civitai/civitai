import { describe, expect, it } from 'vitest';
import { statusFrom } from './player-status';

describe('statusFrom', () => {
  it('starts at level 1 and moves up the shared curve', () => {
    expect(statusFrom('Acolyte', 0)).toMatchObject({
      rank: 'Acolyte',
      level: 1,
      xpForNextLevel: 250,
    });
    expect(statusFrom('Knight', 300)).toMatchObject({ level: 2, xpIntoLevel: 50 });
  });

  it('carries fervor and gold, and defaults them to zero', () => {
    expect(statusFrom('Knight', 0, { fervor: 50, goldPending: 100, goldEarned: 25 })).toMatchObject(
      {
        fervor: 50,
        goldPending: 100,
        goldEarned: 25,
      }
    );
    expect(statusFrom('Acolyte', 0)).toMatchObject({ fervor: 0, goldPending: 0, goldEarned: 0 });
  });
});
