import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The gate END TO END, over the real `getResourceData`: a row goes in, `canGenerate` comes out.
 *
 * The helper tests next door prove the RULE. Nothing proved anyone applies it — reverting this call
 * site to the ungated `pickCovered` left every suite in the repo green.
 */

const { mockIsFlipt, mockFetch } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mockIsFlipt,
}));
vi.mock('~/server/redis/resource-data.redis', () => ({
  resourceDataCache: { fetch: mockFetch, bust: vi.fn() },
}));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn(async () => []) }));
vi.mock('~/server/services/generation/paid-access-gating', () => ({
  applyPaidAccessGating: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/generation/version-generation-state.service', () => ({
  getVisibleSystemWildcardSetIdsByVersionId: vi.fn(async () => new Map()),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

import { getResourceData } from '~/server/services/generation/generation.service';

const VERSION_ID = 5150;

/** An expansion-only checkpoint: the staged rule covers it, the live rule does not. */
const row = (over: Record<string, unknown> = {}) => ({
  id: VERSION_ID,
  name: 'v1',
  trainedWords: [],
  clipSkip: null,
  vaeId: null,
  baseModel: 'SDXL 1.0',
  settings: null,
  availability: 'Public',
  aliasId: null,
  covered: false,
  coveredNext: true,
  generatorLoaded: false,
  status: 'Published',
  usageControl: 'Download',
  flags: 0,
  hasAccess: true,
  model: { id: 99, name: 'A Model', type: 'Checkpoint', nsfw: false, poi: false, userId: 777 },
  ...over,
});

const FREE = { id: 2, tier: 'free' };
const MEMBER = { id: 3, tier: 'gold' };
const MOD = { id: 4, isModerator: true, tier: 'free' };

async function canGenerate(user: Record<string, unknown>, data = row()) {
  mockFetch.mockResolvedValue([data]);
  const [resource] = await getResourceData([VERSION_ID], { user, generation: true });
  return resource?.canGenerate;
}

beforeEach(() => {
  vi.clearAllMocks();
  // coverage-next ON, open-to-all OFF: the state the gate actually ships in.
  mockIsFlipt.mockImplementation(async (flag: string) => flag === 'generation-coverage-next');
});

describe('getResourceData applies the members gate', () => {
  it('refuses a free user a cold expansion checkpoint', async () => {
    expect(await canGenerate(FREE)).toBe(false);
  });

  it('allows a member the same version', async () => {
    expect(await canGenerate(MEMBER)).toBe(true);
  });

  it('allows a moderator on a free tier', async () => {
    expect(await canGenerate(MOD)).toBe(true);
  });

  /** The negative control: residency alone flips the free user, so the refusal IS the gate. */
  it('allows a free user once it is resident', async () => {
    expect(await canGenerate(FREE, row({ generatorLoaded: true }))).toBe(true);
  });

  it('allows a free user anything the live rule covers', async () => {
    expect(await canGenerate(FREE, row({ covered: true }))).toBe(true);
  });

  it('does not gate a non-checkpoint in the expansion', async () => {
    expect(await canGenerate(FREE, row({ model: { ...row().model, type: 'LORA' } }))).toBe(true);
  });

  it('opens it to a free user when the rollout flag is on', async () => {
    mockIsFlipt.mockResolvedValue(true);
    expect(await canGenerate(FREE)).toBe(true);
  });
});
