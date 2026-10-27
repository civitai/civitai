import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Axiom from '../axiom';

// The shared Civitai Moderation account is a moderator, but a session on it never opens this app.
vi.mock('../redis', () => ({ getSysRedis: () => ({}) }));
const logged = vi.hoisted(() =>
  vi.fn<(event: Record<string, unknown>) => Promise<undefined>>(async () => undefined)
);
vi.mock('../axiom', async (importOriginal) => ({
  ...(await importOriginal<typeof Axiom>()),
  logToAxiom: logged,
}));

const { admitsModerator } = await import('../auth');

afterEach(() => {
  delete process.env.CIVITAI_MODERATION_USER_ID;
  logged.mockClear();
});

describe('admitsModerator', () => {
  it('refuses the moderation account and logs it as an error', () => {
    process.env.CIVITAI_MODERATION_USER_ID = '900';
    expect(admitsModerator({ id: 900, isModerator: true })).toBe(false);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'moderation-account-session-refused', type: 'error' })
    );
  });

  it('admits other moderators, and everyone when the account is not configured', () => {
    process.env.CIVITAI_MODERATION_USER_ID = '900';
    expect(admitsModerator({ id: 7, isModerator: true })).toBe(true);
    delete process.env.CIVITAI_MODERATION_USER_ID;
    expect(admitsModerator({ id: 900, isModerator: true })).toBe(true);
    expect(logged).not.toHaveBeenCalled();
  });

  it('refuses non-moderators', () => {
    expect(admitsModerator({ id: 7, isModerator: false })).toBe(false);
  });
});
