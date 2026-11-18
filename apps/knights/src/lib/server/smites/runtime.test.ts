import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredSettings } from '../settings/stored';

const stored = vi.hoisted(() => ({ current: {} as StoredSettings }));
vi.mock('../settings/runtime', () => ({ storedSettings: async () => stored.current }));

import { feedSecret, resetDeps } from './runtime';

afterEach(() => {
  delete process.env.FEED_TOKEN_SECRET;
  delete process.env.JOBS_TOKEN;
  delete process.env.KNIGHTS_APPRENTICE_SMITES;
  stored.current = {};
});

describe('resetDeps.acolyteSmites', () => {
  it('reads KNIGHTS_APPRENTICE_SMITES from the environment on every call when nothing is saved', async () => {
    expect(await resetDeps.acolyteSmites?.()).toBe(true);
    process.env.KNIGHTS_APPRENTICE_SMITES = 'off';
    expect(await resetDeps.acolyteSmites?.()).toBe(false);
  });

  it('follows the switch saved on the moderator page over the environment', async () => {
    process.env.KNIGHTS_APPRENTICE_SMITES = 'off';
    stored.current = { apprenticeSmites: true };
    expect(await resetDeps.acolyteSmites?.()).toBe(true);
  });
});

describe('feedSecret', () => {
  it('returns the configured key', () => {
    process.env.FEED_TOKEN_SECRET = 'key';
    expect(feedSecret()).toBe('key');
  });

  it.each([undefined, '', '  '])(
    'fails closed when the key is %j, whatever else is set',
    (value) => {
      if (value !== undefined) process.env.FEED_TOKEN_SECRET = value;
      process.env.JOBS_TOKEN = 'a-different-secret';
      expect(() => feedSecret()).toThrow(/FEED_TOKEN_SECRET/);
    }
  );
});
