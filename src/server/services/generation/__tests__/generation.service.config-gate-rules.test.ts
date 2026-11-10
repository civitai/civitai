import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIsFliptOnForTesters } = vi.hoisted(() => ({ mockIsFliptOnForTesters: vi.fn() }));

vi.mock('~/server/flipt/tester-segment', () => ({
  isFliptOnForTesters: mockIsFliptOnForTesters,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: {} }));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: vi.fn() }));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({ getLinkedVaeIds: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({ imagesForModelVersionsCache: {} }));
vi.mock('~/server/services/generation/version-generation-state.service', () => ({
  getVisibleSystemWildcardSetIdsByVersionId: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { getGenerationConfig, saveGateRule } from '~/server/services/generation/generation.service';
import {
  experimentalTargets,
  gateMessage,
  rulesToStates,
  selectionGates,
  type GateRule,
} from '~/shared/generation/gates';

const rules: GateRule[] = [
  {
    id: 'rule-mod-hidden',
    name: 'NAME-MOD-HIDDEN',
    availableTo: 'moderators',
    presentation: 'hidden',
    message: 'MESSAGE-MOD-HIDDEN',
    ecosystems: ['EcoHidden'],
    workflows: [],
    modelVersionIds: [101],
  },
  {
    id: 'rule-mod-disabled',
    name: 'NAME-MOD-DISABLED',
    availableTo: 'moderators',
    presentation: 'disabled',
    message: 'Back soon.',
    ecosystems: ['EcoModDisabled'],
    workflows: [],
    modelVersionIds: [],
  },
  {
    id: 'rule-everyone',
    name: 'NAME-EVERYONE',
    availableTo: 'nobody',
    presentation: 'disabled',
    message: 'Provider outage.',
    ecosystems: ['EcoDown'],
    workflows: [],
    modelVersionIds: [202],
  },
  {
    id: 'rule-experimental',
    name: 'NAME-EXPERIMENTAL',
    availableTo: 'moderators',
    presentation: 'experimental',
    message: 'Early build.',
    ecosystems: ['EcoNew'],
    workflows: [],
    modelVersionIds: [],
  },
];

/** Every string anywhere in the value, keys included. */
function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => [k, ...allStrings(v)]);
  return [];
}

beforeEach(async () => {
  const hashes = new Map<string, Map<string, string>>();
  const hash = (key: string) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key)!;
  };
  const { sysRedis } = redisMock;
  // The migration marker reads as already set, so the stores read the hash alone.
  sysRedis.get.mockResolvedValue('1');
  sysRedis.hGet.mockImplementation(
    async (key: string, field: string) => hash(key).get(field) ?? null
  );
  sysRedis.hGetAll.mockImplementation(async (key: string) => Object.fromEntries(hash(key)));
  sysRedis.hSet.mockImplementation(async (key: string, field: string, value: string) => {
    hash(key).set(field, value);
  });
  mockIsFliptOnForTesters.mockResolvedValue(false);
  for (const rule of rules) await saveGateRule(rule);
});

describe('getGenerationConfig gate rules', () => {
  it('the config carries no rule name or id in any field', async () => {
    const config = await getGenerationConfig({});
    const strings = allStrings(config);

    for (const rule of rules) {
      expect(strings).not.toContain(rule.name);
      expect(strings).not.toContain(rule.id);
    }
    expect(strings.filter((s) => s.startsWith('NAME-'))).toEqual([]);
    expect(config.gateRules.some((r) => 'name' in r || 'id' in r)).toBe(false);
  });

  it("a hidden rule's target is hidden and carries no message", async () => {
    const config = await getGenerationConfig({});

    expect(allStrings(config)).not.toContain('MESSAGE-MOD-HIDDEN');
    const states = rulesToStates(config.gateRules);
    expect(states.ecosystems.get('EcoHidden')?.state).toBe('hidden');
    expect(states.modelVersionIds.get(101)?.state).toBe('hidden');
  });

  it('a rule meant for everyone still arrives, gates its target and shows its message', async () => {
    const config = await getGenerationConfig({});

    const [gate] = selectionGates(config.gateRules, { ecosystem: 'EcoDown' });
    expect(gate).toEqual({ subject: 'ecosystem', state: 'disabled', message: 'Provider outage.' });
    expect(gateMessage(gate)).toBe('This base model is currently unavailable. Provider outage.');
    expect(selectionGates(config.gateRules, { versionIds: [202] })).toHaveLength(1);
    expect(experimentalTargets(config.gateRules).ecosystems.get('EcoNew')).toBe('Early build.');
  });

  it("a moderator keeps access to moderator rules and still sees the everyone rule's gate", async () => {
    const config = await getGenerationConfig({ id: 1, isModerator: true });
    const states = rulesToStates(config.gateRules);

    expect(states.ecosystems.has('EcoHidden')).toBe(false);
    expect(states.ecosystems.has('EcoModDisabled')).toBe(false);
    expect(states.ecosystems.get('EcoDown')).toEqual({
      state: 'disabled',
      message: 'Provider outage.',
    });
    expect(experimentalTargets(config.gateRules).ecosystems.get('EcoNew')).toBe('Early build.');
    expect(allStrings(config).filter((s) => s.startsWith('NAME-'))).toEqual([]);
  });
});
