import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as FliptClient from '~/server/flipt/client';

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
const { isFlipt } = await import('~/server/flipt/client');

const {
  getTextScanMode,
  modeForBucket,
  parseTextScanRollout,
  readTextScanRollouts,
  resetTextScanRolloutCache,
  TEXT_SCAN_ENTITY_TYPES,
  textScanBucket,
  textScanEmEntityType,
  parseTextScanEmEntityType,
  getTextScanWebSearchMode,
  readTextScanWebSearchRollouts,
} = await import('~/server/services/text-scan/mode');
const { isTextScanEntityType } = await import('~/server/services/text-scan/profiles');

const hash = (fields: Record<string, string>) =>
  redisMock.sysRedis.hGetAll.mockResolvedValue(fields as never);

describe('getTextScanMode', () => {
  beforeEach(() => {
    redisMock.sysRedis.hGetAll.mockReset();
    vi.mocked(isFlipt).mockReset().mockResolvedValue(true);
    resetTextScanRolloutCache();
  });

  it('is off for every entity while the text-scan kill switch is off, whatever the rollout', async () => {
    hash({ Model: '{"shadow":100,"active":100}' });
    vi.mocked(isFlipt).mockResolvedValue(false);
    expect(await getTextScanMode('Model', 1)).toBe('off');
    expect(isFlipt).toHaveBeenCalledWith('text-scan');
    vi.mocked(isFlipt).mockRejectedValue(new Error('flipt down'));
    expect(await getTextScanMode('Model', 1)).toBe('off');
  });

  it('is off when the entity type has no field', async () => {
    hash({});
    expect(await getTextScanMode('Post', 42)).toBe('off');
  });

  it('reads the modes hash through the sysRedis read deadline', async () => {
    hash({ Post: '{"shadow":100}' });
    expect(await getTextScanMode('Post', 42)).toBe('shadow');
    expect(redisMock.sysRedis.hGetAll).toHaveBeenCalledWith('system:text-scan:modes');
    expect(redisMock.withSysReadDeadline).toHaveBeenCalled();
  });

  it('is active for every id at active 100, whatever shadow says', async () => {
    hash({ Model: '{"shadow":0,"active":100}' });
    for (const id of [1, 2, 3, 99, 1000]) expect(await getTextScanMode('Model', id)).toBe('active');
  });

  it('reads off when sysRedis throws or a field is not json', async () => {
    redisMock.sysRedis.hGetAll.mockRejectedValueOnce(new Error('down'));
    expect(await getTextScanMode('Model', 1)).toBe('off');
    resetTextScanRolloutCache();
    hash({ Model: '{not json' });
    expect(await getTextScanMode('Model', 1)).toBe('off');
  });

  it('caches the hash between calls', async () => {
    hash({ Post: '{"shadow":100}' });
    await getTextScanMode('Post', 1);
    await getTextScanMode('Post', 2);
    expect(redisMock.sysRedis.hGetAll).toHaveBeenCalledTimes(1);
  });

  it('re-reads the hash once the 15s cache expires', async () => {
    vi.useFakeTimers();
    try {
      hash({ Post: '{"shadow":100}' });
      expect(await getTextScanMode('Post', 1)).toBe('shadow');
      hash({});
      vi.advanceTimersByTime(14_000);
      expect(await getTextScanMode('Post', 1)).toBe('shadow');
      vi.advanceTimersByTime(2_000);
      expect(await getTextScanMode('Post', 1)).toBe('off');
      expect(redisMock.sysRedis.hGetAll).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rollout percentages', () => {
  it('splits ids by a fixed bucket, active first', () => {
    const rollout = { shadow: 100, active: 10 };
    expect(modeForBucket(rollout, 0)).toBe('active');
    expect(modeForBucket(rollout, 9)).toBe('active');
    expect(modeForBucket(rollout, 10)).toBe('shadow');
    expect(modeForBucket(rollout, 99)).toBe('shadow');
    expect(modeForBucket({ shadow: 50, active: 0 }, 50)).toBe('off');
    expect(modeForBucket(undefined, 0)).toBe('off');
  });

  it('gives an id the same bucket every time, and spreads ids across buckets', () => {
    expect(textScanBucket('Model', 123)).toBe(textScanBucket('Model', 123));
    const buckets = new Set(Array.from({ length: 1000 }, (_, i) => textScanBucket('Comment', i)));
    expect(buckets.size).toBeGreaterThan(90);
    for (const b of buckets) expect(b >= 0 && b < 100).toBe(true);
  });

  it('clamps and defaults percentages, and rejects anything that is not an object', () => {
    expect(parseTextScanRollout('{"shadow":150,"active":-3}')).toEqual({ shadow: 100, active: 0 });
    expect(parseTextScanRollout('{"shadow":"100"}')).toEqual({ shadow: 0, active: 0 });
    expect(parseTextScanRollout('null')).toBeUndefined();
    expect(parseTextScanRollout('')).toBeUndefined();
    expect(parseTextScanRollout(undefined)).toBeUndefined();
  });

  it('readTextScanRollouts ignores fields that are not text-scan entity types', async () => {
    hash({ Model: '{"shadow":100}', Tag: '{"shadow":100}' });
    expect(await readTextScanRollouts()).toEqual({ Model: { shadow: 100, active: 0 } });
  });
});

describe('isTextScanEntityType', () => {
  it('covers 14 entity types', () => expect(TEXT_SCAN_ENTITY_TYPES).toHaveLength(14));

  it.each([
    ['Post', true],
    ['UserProfile', true],
    ['Collection', true],
    ['Crucible', true],
    ['Tag', false],
    ['Post:shadow', false],
    ['constructor', false],
    ['toString', false],
    ['__proto__', false],
  ])('%s -> %s', (value, expected) => expect(isTextScanEntityType(value)).toBe(expected));
});

describe('textScanEmEntityType', () => {
  it('keys shadow verdicts apart from the live row and round-trips', () => {
    expect(textScanEmEntityType('Article', 'active')).toBe('Article');
    expect(textScanEmEntityType('Article', 'shadow')).toBe('Article:shadow');
    expect(parseTextScanEmEntityType('Article:shadow')).toEqual({
      entityType: 'Article',
      shadow: true,
    });
    expect(parseTextScanEmEntityType('Article')).toEqual({ entityType: 'Article', shadow: false });
  });
});

describe('getTextScanWebSearchMode', () => {
  const fields = (modes: Record<string, string>, webSearch: Record<string, string>) =>
    redisMock.sysRedis.hGetAll.mockImplementation((async (key: string) =>
      key === 'system:text-scan:web-search' ? webSearch : modes) as never);

  beforeEach(() => {
    redisMock.sysRedis.hGetAll.mockReset();
    vi.mocked(isFlipt).mockReset().mockResolvedValue(true);
    resetTextScanRolloutCache();
  });

  it('is off while the key is unset, and never reads it for an ineligible entity type', async () => {
    fields({ Model: '{"shadow":100,"active":100}', Post: '{"shadow":100}' }, {});
    expect(await getTextScanWebSearchMode('Model', 1)).toBe('off');
    redisMock.sysRedis.hGetAll.mockClear();
    expect(await getTextScanWebSearchMode('Post', 1)).toBe('off');
    expect(redisMock.sysRedis.hGetAll).not.toHaveBeenCalled();
  });

  it('reads its own hash and ignores fields other than Model', async () => {
    fields({}, { Model: '{"shadow":100}', Post: '{"shadow":100}' });
    expect(await readTextScanWebSearchRollouts()).toEqual({ Model: { shadow: 100, active: 0 } });
    expect(redisMock.sysRedis.hGetAll).toHaveBeenCalledWith('system:text-scan:web-search');
  });

  it.each([
    ['off', '{"shadow":0,"active":0}', '{"shadow":100,"active":100}', 'off'],
    ['shadow', '{"shadow":100,"active":0}', '{"shadow":100,"active":100}', 'shadow'],
    ['active', '{"shadow":100,"active":100}', '{"shadow":100,"active":0}', 'shadow'],
    ['active', '{"shadow":100,"active":100}', '{"shadow":100,"active":100}', 'active'],
    ['active', '{"shadow":100,"active":100}', '{"shadow":0,"active":0}', 'off'],
  ])('main %s caps the search rollout (%s / %s) to %s', async (_m, main, search, expected) => {
    fields({ Model: main }, { Model: search });
    expect(await getTextScanWebSearchMode('Model', 1)).toBe(expected);
  });

  it('takes the main mode from the caller instead of re-reading it', async () => {
    fields({}, { Model: '{"shadow":100,"active":100}' });
    expect(await getTextScanWebSearchMode('Model', 1, 'shadow')).toBe('shadow');
    expect(await getTextScanWebSearchMode('Model', 1, 'off')).toBe('off');
  });

  it('is off when the kill switch is off or the hash cannot be read', async () => {
    fields({ Model: '{"shadow":100,"active":100}' }, { Model: '{"shadow":100,"active":100}' });
    vi.mocked(isFlipt).mockResolvedValue(false);
    expect(await getTextScanWebSearchMode('Model', 1, 'active')).toBe('off');
    vi.mocked(isFlipt).mockResolvedValue(true);
    redisMock.sysRedis.hGetAll.mockRejectedValue(new Error('down'));
    expect(await getTextScanWebSearchMode('Model', 1, 'active')).toBe('off');
  });

  it('uses the same bucket as the main rollout', async () => {
    fields({}, { Model: '{"shadow":100,"active":10}' });
    for (const id of [1, 2, 3, 50, 77, 1000])
      expect(await getTextScanWebSearchMode('Model', id, 'active')).toBe(
        textScanBucket('Model', id) < 10 ? 'active' : 'shadow'
      );
  });
});

describe('web-search row keys', () => {
  it('keys each pass apart and round-trips', () => {
    expect(textScanEmEntityType('Model', 'active', 'web-search')).toBe('Model:search');
    expect(textScanEmEntityType('Model', 'shadow', 'web-search')).toBe('Model:search-shadow');
    expect(parseTextScanEmEntityType('Model:search')).toEqual({
      entityType: 'Model',
      shadow: false,
      variant: 'web-search',
    });
    expect(parseTextScanEmEntityType('Model:search-shadow')).toEqual({
      entityType: 'Model',
      shadow: true,
      variant: 'web-search',
    });
  });
});
