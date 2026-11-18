import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredSettings } from '../settings/stored';

const stored = vi.hoisted(() => ({ current: {} as StoredSettings }));
vi.mock('../settings/runtime', () => ({ storedSettings: async () => stored.current }));

import { apprenticeDeps } from './runtime';

afterEach(() => {
  delete process.env.KNIGHTS_APPRENTICE_SMITES;
  stored.current = {};
});

describe('apprenticeDeps.settings', () => {
  it('reads KNIGHTS_APPRENTICE_SMITES from the environment on every call when nothing is saved', async () => {
    expect((await apprenticeDeps.settings?.())?.smites).toBe(true);
    process.env.KNIGHTS_APPRENTICE_SMITES = 'off';
    expect((await apprenticeDeps.settings?.())?.smites).toBe(false);
  });

  it('follows the switch saved on the moderator page over the environment', async () => {
    process.env.KNIGHTS_APPRENTICE_SMITES = 'off';
    stored.current = { apprenticeSmites: true };
    expect((await apprenticeDeps.settings?.())?.smites).toBe(true);
  });
});
