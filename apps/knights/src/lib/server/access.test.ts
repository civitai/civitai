import { beforeEach, describe, expect, it, vi } from 'vitest';

const flipt = vi.hoisted(() => ({
  ensureInitialized: vi.fn(async () => {}),
  isEnabledSync: vi.fn<(...args: unknown[]) => boolean | null>(() => null),
}));
vi.mock('@civitai/flipt', () => ({ createFliptClient: () => flipt }));
vi.mock('@civitai/flipt/context', () => ({
  buildFliptContext: (user: { id: number }) => ({ userId: String(user.id) }),
}));

const { accessFor, KNIGHTS_APP_FLAG } = await import('./access');

const user = (isModerator = false) => ({ id: 7, isModerator } as never);

beforeEach(() => {
  (globalThis as { knightsFlipt?: unknown }).knightsFlipt = undefined;
  flipt.ensureInitialized.mockReset().mockResolvedValue(undefined);
  flipt.isEnabledSync.mockReset().mockReturnValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('accessFor', () => {
  it('evaluates the dedicated flag per user with their Flipt context', async () => {
    flipt.isEnabledSync.mockReturnValue(true);
    expect(await accessFor(user())).toBe('allow');
    expect(flipt.isEnabledSync).toHaveBeenCalledWith(KNIGHTS_APP_FLAG, '7', { userId: '7' });
  });

  it('closes the app to a non-moderator when the flag is off', async () => {
    flipt.isEnabledSync.mockReturnValue(false);
    expect(await accessFor(user())).toBe('closed');
  });

  it('fails closed for a non-moderator when the flag does not exist', async () => {
    flipt.isEnabledSync.mockReturnValue(null);
    expect(await accessFor(user())).toBe('closed');
  });

  it('fails closed for a non-moderator when Flipt is down, but keeps moderators in', async () => {
    flipt.ensureInitialized.mockRejectedValue(new Error('flipt unreachable'));
    expect(await accessFor(user())).toBe('closed');
    expect(await accessFor(user(true))).toBe('allow');
  });
});
