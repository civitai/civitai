import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUserSettings = vi.fn();
const patchUserSettings = vi.fn();
vi.mock('~/server/services/user.service', () => ({
  getUserSettings: (...args: unknown[]) => getUserSettings(...args),
  patchUserSettings: (...args: unknown[]) => patchUserSettings(...args),
}));

import {
  acceptGenerationLicense,
  assertGenerationLicenseAccepted,
} from '~/server/services/generation-license.service';
import { setUserSettingsInput } from '~/server/schema/user.schema';
import { getGenerationLicenseTerms } from '~/shared/constants/generation-license.constants';

const terms = getGenerationLicenseTerms('MiniMaxH3Image')!;

beforeEach(() => {
  getUserSettings.mockReset();
  patchUserSettings.mockReset();
});

describe('generation licence acceptance', () => {
  it('names the licence, its Acceptable Use Policy and the bar on improving other models', () => {
    const text = [terms.intro, terms.licenseName, ...terms.restrictions].join(' ');
    expect(text).toContain('MiniMax-H3-Image Community License Agreement');
    expect(text).toContain('Acceptable Use Policy');
    expect(text).toMatch(/improve any other AI model/);
    // The licence's territory clauses are not ours to bind users to (Legal, 11 Nov 2026).
    expect(terms.intro).toMatch(/except the territory limits in Section V\.4 and Exhibit A item 1/);
    expect(terms.licenseUrl).toMatch(/MiniMax-H3-Image\/blob\/[0-9a-f]{40}\/LICENSE$/);
  });

  it('refuses a submit on the ecosystem until the user has accepted', async () => {
    getUserSettings.mockResolvedValue({});
    await expect(
      assertGenerationLicenseAccepted({ ecosystem: 'MiniMaxH3Image', userId: 7 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses an acceptance of an older version of the terms', async () => {
    getUserSettings.mockResolvedValue({
      generationLicenseAcceptances: {
        [terms.key]: { version: terms.version - 1, acceptedAt: new Date() },
      },
    });
    await expect(
      assertGenerationLicenseAccepted({ ecosystem: 'MiniMaxH3Image', userId: 7 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets an accepted user through', async () => {
    getUserSettings.mockResolvedValue({
      generationLicenseAcceptances: {
        [terms.key]: { version: terms.version, acceptedAt: new Date() },
      },
    });
    await expect(
      assertGenerationLicenseAccepted({ ecosystem: 'MiniMaxH3Image', userId: 7 })
    ).resolves.toBeUndefined();
  });

  it('asks nothing of other ecosystems', async () => {
    await expect(
      assertGenerationLicenseAccepted({ ecosystem: 'SDXL', userId: 7 })
    ).resolves.toBeUndefined();
    expect(getUserSettings).not.toHaveBeenCalled();
  });

  it('records the acceptance on the user with the terms version and the server time', async () => {
    const before = Date.now();
    await acceptGenerationLicense({ userId: 7, ecosystem: 'MiniMaxH3Image' });
    const [userId, patch] = patchUserSettings.mock.calls[0];
    expect(userId).toBe(7);
    const record = patch.mergeInto.generationLicenseAcceptances[terms.key];
    expect(record.version).toBe(terms.version);
    expect(Date.parse(record.acceptedAt)).toBeGreaterThanOrEqual(before);
  });

  it('refuses to record an acceptance for an ecosystem with no licence', async () => {
    await expect(acceptGenerationLicense({ userId: 7, ecosystem: 'SDXL' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(patchUserSettings).not.toHaveBeenCalled();
  });

  // Only the accept mutation may write it; the generic settings write must not forge one.
  it('cannot be written through user.setSettings', () => {
    const parsed = setUserSettingsInput.parse({
      generationLicenseAcceptances: { [terms.key]: { version: 99, acceptedAt: new Date() } },
    });
    expect(parsed).not.toHaveProperty('generationLicenseAcceptances');
  });
});
