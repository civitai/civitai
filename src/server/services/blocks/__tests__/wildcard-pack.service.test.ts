import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';

import { ModelStatus, ModelType, Availability, ModelModifier } from '~/shared/utils/prisma/enums';
import {
  sfwBrowsingLevelsFlag,
  allBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

/**
 * Gate + cache coverage for getWildcardPackContent. dbRead / redis / the
 * delivery worker are mocked (no live db or redis needed): these tests prove
 * the REFUSAL matrix (type gate, publish states, availability, early access,
 * maturity), the pre-download size cap, and that a cache hit skips the
 * storage fetch entirely.
 */

const { mockFindFirst, mockRedisGet, mockRedisSet, mockResolveDownloadUrl } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockResolveDownloadUrl: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { modelVersion: { findFirst: mockFindFirst } },
}));

vi.mock('~/server/redis/client', () => ({
  redis: { get: mockRedisGet, set: mockRedisSet },
  REDIS_KEYS: { BLOCKS: { WILDCARD_PACK: 'blocks:wildcard-pack' } },
}));

vi.mock('~/utils/delivery-worker', () => ({
  resolveDownloadUrl: mockResolveDownloadUrl,
}));

import {
  getWildcardPackContent,
  MAX_PACK_FILE_KB,
} from '~/server/services/blocks/wildcard-pack.service';

async function zipBytes(entries: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [p, c] of Object.entries(entries)) zip.file(p, c);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function fakeVersion(over: any = {}) {
  return {
    id: 111,
    name: 'v1.0',
    status: ModelStatus.Published,
    availability: Availability.Public,
    earlyAccessEndsAt: null,
    model: {
      id: 42,
      name: 'Fantasy Pack',
      type: ModelType.Wildcards,
      status: ModelStatus.Published,
      mode: null,
      nsfwLevel: 1,
      availability: Availability.Public,
      user: { username: 'alice' },
      ...(over.model ?? {}),
    },
    files: over.files ?? [{ id: 7, name: 'pack.zip', url: 'u', sizeKB: 100, type: 'Archive' }],
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'model' && k !== 'files')),
  };
}

const sfw = { modelVersionId: 111, browsingLevel: sfwBrowsingLevelsFlag };

beforeEach(() => {
  vi.clearAllMocks();
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockResolveDownloadUrl.mockResolvedValue({ url: 'https://signed.example/pack.zip' });
});

function stubFetch(bytes: ArrayBuffer) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes }))
  );
}

describe('getWildcardPackContent — refusal matrix', () => {
  it('unknown version -> not-found', async () => {
    mockFindFirst.mockResolvedValue(null);
    expect((await getWildcardPackContent(sfw)).status).toBe('not-found');
  });

  it('non-Wildcards model type -> not-found (the exfil-proxy gate)', async () => {
    mockFindFirst.mockResolvedValue(fakeVersion({ model: { type: ModelType.Checkpoint } }));
    expect((await getWildcardPackContent(sfw)).status).toBe('not-found');
    expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['unpublished model', { model: { status: ModelStatus.Unpublished } }],
    ['deleted model', { model: { status: ModelStatus.Deleted } }],
    ['unpublished version', { status: ModelStatus.Unpublished }],
    ['archived model', { model: { mode: ModelModifier.Archived } }],
    ['taken-down model', { model: { mode: ModelModifier.TakenDown } }],
    ['private model', { model: { availability: Availability.Private } }],
    ['private version', { availability: Availability.Private }],
    ['early-access version', { earlyAccessEndsAt: new Date(Date.now() + 86_400_000) }],
    ['no files', { files: [] }],
  ])('%s -> not-found', async (_label, over) => {
    mockFindFirst.mockResolvedValue(fakeVersion(over));
    expect((await getWildcardPackContent(sfw)).status).toBe('not-found');
  });

  it('nsfwLevel above the clamped ceiling -> forbidden; within a red ceiling -> ok', async () => {
    mockFindFirst.mockResolvedValue(fakeVersion({ model: { nsfwLevel: 16 } }));
    expect((await getWildcardPackContent(sfw)).status).toBe('forbidden');

    stubFetch(await zipBytes({ 'race.txt': 'elf' }));
    mockFindFirst.mockResolvedValue(fakeVersion({ model: { nsfwLevel: 16 } }));
    const red = await getWildcardPackContent({
      modelVersionId: 111,
      browsingLevel: allBrowsingLevelsFlag,
    });
    expect(red.status).toBe('ok');
  });

  it('file over the size cap -> too-large, WITHOUT downloading', async () => {
    mockFindFirst.mockResolvedValue(
      fakeVersion({
        files: [
          { id: 7, name: 'pack.zip', url: 'u', sizeKB: MAX_PACK_FILE_KB + 1, type: 'Archive' },
        ],
      })
    );
    expect((await getWildcardPackContent(sfw)).status).toBe('too-large');
    expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
  });
});

describe('getWildcardPackContent — happy path + cache', () => {
  it('parses the archive and returns attribution + lists', async () => {
    mockFindFirst.mockResolvedValue(fakeVersion());
    stubFetch(await zipBytes({ 'race.txt': 'elf\ndwarf' }));

    const result = await getWildcardPackContent(sfw);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.body).toMatchObject({
      modelId: 42,
      modelVersionId: 111,
      modelName: 'Fantasy Pack',
      versionName: 'v1.0',
      creatorUsername: 'alice',
      lists: { race: ['elf', 'dwarf'] },
      truncated: false,
    });
    // Parsed content was written to the cache with a TTL.
    expect(mockRedisSet).toHaveBeenCalledWith(
      'blocks:wildcard-pack:111',
      expect.any(String),
      expect.objectContaining({ EX: expect.any(Number) })
    );
  });

  it('a cache hit skips the storage fetch entirely', async () => {
    mockFindFirst.mockResolvedValue(fakeVersion());
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        lists: { race: ['cached-elf'] },
        truncated: false,
        truncatedLists: [],
        modelName: 'Fantasy Pack',
        versionName: 'v1.0',
        creatorUsername: 'alice',
      })
    );

    const result = await getWildcardPackContent(sfw);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.body.lists).toEqual({ race: ['cached-elf'] });
    expect(mockResolveDownloadUrl).not.toHaveBeenCalled();
  });

  it('a redis error fails open to the storage fetch; a set error is swallowed', async () => {
    mockFindFirst.mockResolvedValue(fakeVersion());
    mockRedisGet.mockRejectedValue(new Error('redis down'));
    mockRedisSet.mockRejectedValue(new Error('redis down'));
    stubFetch(await zipBytes({ 'race.txt': 'elf' }));

    const result = await getWildcardPackContent(sfw);
    expect(result.status).toBe('ok');
  });

  it('a failed storage fetch -> fetch-failed (transient, retryable)', async () => {
    mockFindFirst.mockResolvedValue(fakeVersion());
    mockResolveDownloadUrl.mockRejectedValue(new Error('resolver down'));
    expect((await getWildcardPackContent(sfw)).status).toBe('fetch-failed');
  });

  it('the maturity gate runs BEFORE the cache read (no cache-based probe)', async () => {
    mockFindFirst.mockResolvedValue(fakeVersion({ model: { nsfwLevel: 16 } }));
    mockRedisGet.mockResolvedValue(JSON.stringify({ lists: { race: ['x'] } }));
    expect((await getWildcardPackContent(sfw)).status).toBe('forbidden');
    expect(mockRedisGet).not.toHaveBeenCalled();
  });
});
