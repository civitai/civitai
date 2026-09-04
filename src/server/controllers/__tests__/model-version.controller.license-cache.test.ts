import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModelVersionService from '~/server/services/model-version.service';

/**
 * `getStaticContent` caches parsed static content in-memory for 5 minutes and returns the cached
 * object BY REFERENCE. The license handler used to assign the Attachment B addendum onto that
 * object's `.content`, so every later request re-appended onto an already-appended string and the
 * page grew a new "Additional Restrictions" block per refresh until the TTL expired.
 *
 * The real cache and the real addendum builder are both exercised here — a mock of either would
 * describe the bug instead of reproducing it.
 */

const { mockGetVersionById } = vi.hoisted(() => ({ mockGetVersionById: vi.fn() }));

// The controller reaches the orchestrator caller through training.service, which throws on a
// missing token at import. Nothing on this path calls it.
vi.mock('~/server/services/training.service', () => ({}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  getVersionById: mockGetVersionById,
}));

import { getVersionLicenseHandler } from '~/server/controllers/model-version.controller';
import { getStaticContent } from '~/server/services/content.service';

const LICENSE_SLUG = 'CreativeML Open RAIL++-M';
const ADDENDUM_MARKER = /This Attachment B supplements the license/g;

const countAddenda = (content: string) => (content.match(ADDENDUM_MARKER) ?? []).length;

const version = {
  id: 4242,
  name: 'v1.0',
  baseModel: 'SDXL 1.0',
  status: 'Published',
  model: {
    id: 909,
    name: 'Test Model',
    status: 'Published',
    allowCommercialUse: ['Image'],
    allowDerivatives: false,
    allowNoCredit: false,
    allowDifferentLicense: true,
    user: { username: 'tester' },
  },
};

const callHandler = () =>
  getVersionLicenseHandler({ input: { id: version.id } } as never) as Promise<{
    license: { content: string };
  }>;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetVersionById.mockResolvedValue(version);
});

describe('getVersionLicenseHandler — Attachment B against the static-content cache', () => {
  it('returns exactly one addendum on every request', async () => {
    const first = await callHandler();
    expect(countAddenda(first.license.content)).toBe(1);

    for (let i = 0; i < 4; i++) {
      const next = await callHandler();
      expect(countAddenda(next.license.content)).toBe(1);
    }
  });

  it('leaves the cached static content free of the addendum', async () => {
    await callHandler();

    const cached = await getStaticContent({ slug: ['licenses', LICENSE_SLUG] });
    expect(countAddenda(cached.content)).toBe(0);
  });

  it('gives concurrent requests identical content', async () => {
    const results = await Promise.all([callHandler(), callHandler(), callHandler()]);
    const contents = new Set(results.map((r) => r.license.content));

    expect(contents.size).toBe(1);
    expect(countAddenda(results[0].license.content)).toBe(1);
  });
});
