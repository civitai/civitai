import { beforeEach, describe, expect, it, vi } from 'vitest';

const flipt = vi.hoisted(() => ({
  ensureInitialized: vi.fn(async () => {}),
  getClientSync: vi.fn<() => object | null>(() => ({})),
  isEnabledSync: vi.fn<(...args: unknown[]) => boolean | null>(() => null),
}));
vi.mock('@civitai/flipt', () => ({ createFliptClient: () => flipt }));
vi.mock('@civitai/flipt/context', () => ({
  buildFliptContext: (user: { id: number }) => ({ userId: String(user.id) }),
}));

const { accessFor, accessibleIds, KNIGHTS_APP_FLAG } = await import('./access');

const user = (isModerator = false) => ({ id: 7, isModerator } as never);

beforeEach(() => {
  (globalThis as { knightsFlipt?: unknown }).knightsFlipt = undefined;
  flipt.ensureInitialized.mockReset().mockResolvedValue(undefined);
  flipt.getClientSync.mockReset().mockReturnValue({});
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

describe('accessibleIds', () => {
  it('lets in moderators and users the flag is on for, and nobody else', async () => {
    flipt.isEnabledSync.mockImplementation((_flag, entity) => entity === '2');

    const open = await accessibleIds([
      { id: 1, isModerator: true },
      { id: 2, isModerator: false },
      { id: 3, isModerator: false },
    ]);

    expect(open).toEqual({ ids: [1, 2], unknown: false });
  });

  it('lets in only moderators when Flipt is down, and says it could not tell', async () => {
    flipt.ensureInitialized.mockRejectedValue(new Error('down'));

    const open = await accessibleIds([
      { id: 1, isModerator: true },
      { id: 2, isModerator: false },
    ]);

    expect(open).toEqual({ ids: [1], unknown: true });
  });

  it('says it could not tell when the client swallowed its init failure', async () => {
    flipt.getClientSync.mockReturnValue(null);

    const open = await accessibleIds([
      { id: 1, isModerator: true },
      { id: 2, isModerator: false },
    ]);

    expect(open).toEqual({ ids: [1], unknown: true });
  });

  it('still answers from local overrides when there is no client', async () => {
    flipt.getClientSync.mockReturnValue(null);
    flipt.isEnabledSync.mockReturnValue(true);

    expect(await accessibleIds([{ id: 2, isModerator: false }])).toEqual({
      ids: [2],
      unknown: false,
    });
  });

  it('does not report unknown when only moderators were asked about', async () => {
    flipt.ensureInitialized.mockRejectedValue(new Error('down'));

    expect(await accessibleIds([{ id: 1, isModerator: true }])).toEqual({ ids: [1], unknown: false });
  });
});
