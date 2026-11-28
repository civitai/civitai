import { describe, expect, it, vi } from 'vitest';
import {
  edgeVerdict,
  findAbsentImages,
  type AbsentImageDeps,
} from '~/server/services/article-absent-images';

const KEY = '11111111-2222-4333-8444-555555555555';
const OTHER = '66666666-7777-4888-9999-000000000000';

const deps = (over: Partial<AbsentImageDeps> = {}): AbsentImageDeps => ({
  probeStore: vi.fn(async () => 'absent' as const),
  probeEdge: vi.fn(async () => 'absent' as const),
  deniedUrls: vi.fn(async () => new Set<string>()),
  ...over,
});

const find = (d: AbsentImageDeps, images = [{ id: 1, url: KEY }]) => findAbsentImages(images, d);

describe('findAbsentImages: a file counts as gone only when both stores say so', () => {
  // Kills: `isConfirmedAbsent` returning true for any store answer, or dropping the edge check.
  it('confirms an image the upload store and the image server both answer absent for', async () => {
    expect(await find(deps())).toEqual(new Set([1]));
  });

  // Kills: trusting the upload store alone; a key kept in another store answers absent there.
  it('keeps an image the image server still serves', async () => {
    expect(await find(deps({ probeEdge: async () => 'present' }))).toEqual(new Set());
  });

  // Kills: treating any non-200 from the image server (5xx, 403, a timeout) as absent.
  it('keeps an image the image server gave no clear answer for', async () => {
    expect(await find(deps({ probeEdge: async () => 'unknown' }))).toEqual(new Set());
  });

  // Kills: ignoring the deny list; a denied url answers 404 with its file stored.
  it('keeps an image whose url the image server is told to deny', async () => {
    expect(await find(deps({ deniedUrls: async () => new Set([KEY]) }))).toEqual(new Set());
  });

  // Kills: reading an unreadable upload store as absent.
  it('keeps an image the upload store could not answer for, without asking the image server', async () => {
    const d = deps({ probeStore: async () => 'unknown' });
    expect(await find(d)).toEqual(new Set());
    expect(d.probeEdge).not.toHaveBeenCalled();
  });

  // Kills: carrying on with an empty deny list when the lookup fails.
  it('confirms nothing when the deny list cannot be read', async () => {
    const d = deps({
      deniedUrls: async () => {
        throw new Error('replica down');
      },
    });
    expect(await find(d)).toEqual(new Set());
    expect(d.probeStore).not.toHaveBeenCalled();
  });

  // Kills: probing a url that is not an upload key, whose 404 means nothing.
  it('never probes a url that is not an upload key', async () => {
    const d = deps();
    expect(await find(d, [{ id: 2, url: 'https://example.com/a.png' }])).toEqual(new Set());
    expect(d.probeStore).not.toHaveBeenCalled();
  });

  it('decides each image on its own answers', async () => {
    const d = deps({ probeEdge: async (key) => (key === KEY ? 'absent' : 'present') });
    const images = [
      { id: 1, url: KEY },
      { id: 2, url: OTHER },
    ];
    expect(await find(d, images)).toEqual(new Set([1]));
  });
});

describe('edgeVerdict', () => {
  // Kills: `status >= 400` as absent, which would read a 403 or a 503 as a missing file.
  it.each([
    [404, 'absent'],
    [200, 'present'],
    [206, 'present'],
    [403, 'unknown'],
    [500, 'unknown'],
    [503, 'unknown'],
    [410, 'unknown'],
  ])('reads %i as %s', (status, verdict) => {
    expect(edgeVerdict(status)).toBe(verdict);
  });
});
