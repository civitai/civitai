import { describe, expect, it, vi } from 'vitest';
import {
  canUserOpenAppRunPages,
  type RunPageAccessReaders,
} from '~/server/services/blocks/app-run-page-access';
import { canOpenAppRunPages } from '~/shared/utils/app-blocks-access';
import type { SessionUser } from '~/types/session';

/**
 * Whether the submitter of an approved app can open its run page, read at send time. The run
 * page 404s unless the viewer has BOTH `appBlocks` and `appBlocksPages`, and the approved email
 * links there only when this says true.
 */

const USER = { id: 4242, username: 'dev', isModerator: false } as unknown as SessionUser;

function readers(over: Partial<RunPageAccessReaders> = {}) {
  return {
    getSessionUser: vi.fn<RunPageAccessReaders['getSessionUser']>(async () => USER),
    getFeatureFlags: vi.fn<RunPageAccessReaders['getFeatureFlags']>(async () => ({
      appBlocks: true,
      appBlocksPages: true,
    })),
    ...over,
  };
}

describe('canOpenAppRunPages (the run page gate)', () => {
  it.each([
    [{ appBlocks: true, appBlocksPages: true }, true],
    [{ appBlocks: true }, false],
    [{ appBlocksPages: true }, false],
    [{ appBlocks: true, appBlocksPages: false }, false],
    [{}, false],
    [null, false],
    [undefined, false],
  ])('%j → %s', (features, expected) => {
    expect(canOpenAppRunPages(features)).toBe(expected);
  });
});

describe('canUserOpenAppRunPages', () => {
  it('🔴 true only with both run-page flags, evaluated for the hydrated user', async () => {
    const r = readers();
    await expect(canUserOpenAppRunPages(4242, r)).resolves.toBe(true);
    expect(r.getSessionUser.mock.calls).toEqual([[4242]]);
    expect(r.getFeatureFlags.mock.calls).toEqual([[USER]]);
  });

  it.each([
    ['only appBlocks', { appBlocks: true }],
    ['only appBlocksPages', { appBlocksPages: true }],
    ['neither', {}],
  ])('🔴 false with %s (the run page would 404)', async (_label, flags) => {
    const r = readers({ getFeatureFlags: vi.fn(async () => flags) });
    await expect(canUserOpenAppRunPages(4242, r)).resolves.toBe(false);
  });

  it('false for a user that does not resolve, without reading flags', async () => {
    const r = readers({ getSessionUser: vi.fn(async () => null) });
    await expect(canUserOpenAppRunPages(4242, r)).resolves.toBe(false);
    expect(r.getFeatureFlags).not.toHaveBeenCalled();
  });

  it.each([
    ['the user read', { getSessionUser: vi.fn(async () => Promise.reject(new Error('down'))) }],
    ['the flag read', { getFeatureFlags: vi.fn(async () => Promise.reject(new Error('down'))) }],
  ])('false when %s fails', async (_label, over) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(canUserOpenAppRunPages(4242, readers(over))).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
