import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The hub's flag read: off whenever Flipt is unconfigured or the read fails, so a broken or absent
// Flipt leaves every flagged path on its pre-flag behaviour. The Flipt client is the boundary here.

const h = vi.hoisted(() => ({
  created: 0,
  isEnabled: vi.fn<(flag: string) => Promise<boolean>>(async () => true),
}));
vi.mock('@civitai/flipt', () => ({
  createFliptClient: () => {
    h.created++;
    return { isEnabled: h.isEnabled };
  },
}));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: vi.fn(async () => undefined) }));

import { isGlobalFlagOn } from '../flipt';

const saved = process.env.FLIPT_URL;
beforeEach(() => {
  h.created = 0;
  h.isEnabled.mockReset();
  h.isEnabled.mockResolvedValue(true);
  delete (globalThis as { hubFlipt?: unknown }).hubFlipt;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FLIPT_URL;
  else process.env.FLIPT_URL = saved;
});

describe('isGlobalFlagOn', () => {
  it('reads the flag when Flipt is configured (positive control)', async () => {
    process.env.FLIPT_URL = 'http://flipt.test';
    expect(await isGlobalFlagOn('oauth-offline-grant')).toBe(true);
    expect(h.isEnabled).toHaveBeenCalledWith('oauth-offline-grant');
  });

  it('is off with FLIPT_URL unset, and builds no client', async () => {
    delete process.env.FLIPT_URL;
    expect(await isGlobalFlagOn('oauth-offline-grant')).toBe(false);
    expect(h.created).toBe(0);
    expect(h.isEnabled).not.toHaveBeenCalled();
  });

  it('is off, not an error, when the read throws', async () => {
    process.env.FLIPT_URL = 'http://flipt.test';
    h.isEnabled.mockRejectedValue(new Error('flipt down'));
    await expect(isGlobalFlagOn('oauth-offline-grant')).resolves.toBe(false);
  });
});
