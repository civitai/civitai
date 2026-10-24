import { describe, expect, it, vi } from 'vitest';
import type * as EnvClient from '~/env/client';
import { MediaType } from '~/shared/utils/prisma/enums';

vi.mock('~/env/client', async (importOriginal) => {
  const real = await importOriginal<typeof EnvClient>();
  return { ...real, env: { ...real.env, NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.example/abc' } };
});

const { getImageEdgePurgeUrls } = await import('~/server/services/image-edge-purge');

const KEY = '00000000-0000-4000-8000-000000000001';
const BASE = `https://image.example/abc/${KEY}`;

describe('getImageEdgePurgeUrls', () => {
  it('names each url as a browser requests it, key-named first', () => {
    const urls = getImageEdgePurgeUrls({
      url: KEY,
      id: 42,
      name: 'my cat.png',
      type: MediaType.image,
    });

    expect(urls.slice(0, 3)).toEqual([
      `${BASE}/original=true/${KEY}.jpeg`,
      `${BASE}/anim=false,original=true/${KEY}.jpeg`,
      `${BASE}/width=96/${KEY}.jpeg`,
    ]);
    expect(urls).toEqual(
      expect.arrayContaining([
        `${BASE}/original=true/42.jpeg`,
        `${BASE}/original=true/my%20cat.jpeg`,
        `${BASE}/anim=false,original=true/my%20cat.jpeg`,
        `${BASE}/anim=false,width=1200,optimized=true/my%20cat.jpeg`,
      ])
    );
    expect(urls.some((x) => x.includes(' '))).toBe(false);
    expect(urls).toHaveLength(102);
    // Owner input never comes before a key-named url.
    const firstNamed = urls.findIndex((x) => !x.endsWith(`/${KEY}.jpeg`));
    expect(urls.slice(firstNamed).every((x) => !x.endsWith(`/${KEY}.jpeg`))).toBe(true);
  });

  it("covers a video's still frames and its image-typed urls", () => {
    const urls = getImageEdgePurgeUrls({ url: KEY, id: 7, type: MediaType.video });
    expect(urls).toEqual(
      expect.arrayContaining([
        `${BASE}/anim=false,transcode=true,width=450/${KEY}.mp4`,
        `${BASE}/original=true/${KEY}.jpeg`,
        `${BASE}/original=true/7.mp4`,
      ])
    );
  });
});
