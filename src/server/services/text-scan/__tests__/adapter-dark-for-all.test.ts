import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
const { isFlipt } = await import('~/server/flipt/client');

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import {
  getModerationAdapter,
  getSupportedModerationEntityTypes,
} from '~/server/services/moderation-adapters';
import {
  resetTextScanRolloutCache,
  TEXT_SCAN_ENTITY_TYPES,
  TEXT_SCAN_WEB_SEARCH_ENTITY_TYPES,
  type TextScanRollout,
} from '~/server/services/text-scan/mode';

const ENTITY_IDS = Array.from({ length: 1000 }, (_, i) => i + 1);

const set = (
  killSwitch: boolean,
  main: TextScanRollout | undefined,
  search: TextScanRollout | undefined
) => {
  vi.mocked(isFlipt).mockResolvedValue(killSwitch);
  const fields = (types: readonly string[], rollout: TextScanRollout | undefined) =>
    rollout ? Object.fromEntries(types.map((t) => [t, JSON.stringify(rollout)])) : {};
  redisMock.sysRedis.hGetAll.mockImplementation((async (key: string) =>
    key === REDIS_SYS_KEYS.TEXT_SCAN.MODES
      ? fields(TEXT_SCAN_ENTITY_TYPES, main)
      : key === REDIS_SYS_KEYS.TEXT_SCAN.WEB_SEARCH
      ? fields(TEXT_SCAN_WEB_SEARCH_ENTITY_TYPES, search)
      : {}) as never);
  resetTextScanRolloutCache();
};

// The retry job leaves a dark-for-all type out of its query, so a wrong `true` here strands every
// row of a type that is live for some entities.
describe('an adapter is dark for all exactly when no entity is enabled', () => {
  beforeEach(() => redisMock.sysRedis.hGetAll.mockReset());

  it.each([
    ['kill switch off', false, { shadow: 100, active: 100 }, { shadow: 100, active: 100 }],
    ['no rollouts', true, undefined, undefined],
    ['all shadow', true, { shadow: 100, active: 0 }, { shadow: 100, active: 0 }],
    ['all active', true, { shadow: 0, active: 100 }, { shadow: 0, active: 100 }],
    [
      'one bucket active, the next shadow',
      true,
      { shadow: 2, active: 1 },
      { shadow: 2, active: 1 },
    ],
    ['shadow no wider than active', true, { shadow: 10, active: 10 }, undefined],
    ['search shadow under active main', true, { shadow: 0, active: 50 }, { shadow: 50, active: 0 }],
  ] as const)('%s', async (_, killSwitch, main, search) => {
    set(killSwitch, main, search);
    let checked = 0;
    for (const type of getSupportedModerationEntityTypes()) {
      const adapter = getModerationAdapter(type)!;
      if (!adapter.isDarkForAll || !adapter.isEnabled) continue;
      const dark = await adapter.isDarkForAll();
      let enabled = false;
      for (const entityId of ENTITY_IDS)
        if (await adapter.isEnabled({ entityId })) {
          enabled = true;
          break;
        }
      checked++;
      expect(`${type}: ${dark}`).toBe(`${type}: ${!enabled}`);
    }
    expect(checked).toBeGreaterThan(20);
  });
});
