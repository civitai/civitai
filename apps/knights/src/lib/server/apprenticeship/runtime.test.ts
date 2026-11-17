import { afterEach, describe, expect, it } from 'vitest';
import { apprenticeDeps } from './runtime';

afterEach(() => {
  delete process.env.KNIGHTS_APPRENTICE_SMITES;
});

describe('apprenticeDeps.settings', () => {
  it('reads KNIGHTS_APPRENTICE_SMITES from the environment on every call', () => {
    expect(apprenticeDeps.settings?.().smites).toBe(true);
    process.env.KNIGHTS_APPRENTICE_SMITES = 'off';
    expect(apprenticeDeps.settings?.().smites).toBe(false);
  });
});
