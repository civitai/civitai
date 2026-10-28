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
});
