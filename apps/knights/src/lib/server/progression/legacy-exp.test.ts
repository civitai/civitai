import { describe, expect, it, vi } from 'vitest';
import { LEGACY_EXP_KEY, legacyExpMirror, mirrorXp } from './legacy-exp';

describe('legacyExpMirror', () => {
  it('increments the original game hash field for the player, only when it is present', async () => {
    const evalMock = vi.fn(async () => 110);
    await legacyExpMirror(() => ({ eval: evalMock }))([
      { playerId: 7, xp: 10 },
      { playerId: 8, xp: 0 },
    ]);

    expect(LEGACY_EXP_KEY).toBe('new-order:exp');
    expect(evalMock).toHaveBeenCalledTimes(1);
    expect(evalMock).toHaveBeenCalledWith(expect.stringContaining('HEXISTS'), {
      keys: ['new-order:exp'],
      arguments: ['7', '10'],
    });
  });
});

describe('mirrorXp', () => {
  it('logs a failing mirror instead of throwing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      mirrorXp(async () => Promise.reject(new Error('down')), [{ playerId: 1, xp: 5 }])
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it('does nothing without a mirror or without deltas', async () => {
    const mirror = vi.fn();
    await mirrorXp(undefined, [{ playerId: 1, xp: 5 }]);
    await mirrorXp(mirror, []);
    expect(mirror).not.toHaveBeenCalled();
  });
});
