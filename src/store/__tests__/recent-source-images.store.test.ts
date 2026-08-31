import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RECENT_SOURCE_IMAGES,
  dedupeSourceImages,
  recentSourceImagesStore,
  useRecentSourceImagesStore,
} from '~/store/recent-source-images.store';

function image(n: number) {
  return {
    url: `https://orchestration.civitai.com/v2/consumer/blobs/${n}.jpeg`,
    width: 8,
    height: 8,
  };
}

describe('recentSourceImagesStore', () => {
  beforeEach(() => {
    recentSourceImagesStore.clear();
    vi.useRealTimers();
  });

  it('keeps only the most recent MAX_RECENT_SOURCE_IMAGES entries', () => {
    vi.useFakeTimers();
    for (let i = 0; i < MAX_RECENT_SOURCE_IMAGES + 5; i++) {
      vi.advanceTimersByTime(1000);
      recentSourceImagesStore.record([image(i)]);
    }

    const { images } = useRecentSourceImagesStore.getState();
    expect(images).toHaveLength(MAX_RECENT_SOURCE_IMAGES);
    // Newest first, and the five oldest are gone.
    expect(images[0].url).toBe(image(MAX_RECENT_SOURCE_IMAGES + 4).url);
    expect(images.some((img) => img.url === image(0).url)).toBe(false);
  });

  it('bumps an existing url instead of duplicating it', () => {
    vi.useFakeTimers();
    recentSourceImagesStore.record([image(1)]);
    recentSourceImagesStore.record([image(2)]);
    vi.advanceTimersByTime(1000);
    recentSourceImagesStore.record([image(1)]);

    const { images } = useRecentSourceImagesStore.getState();
    expect(images).toHaveLength(2);
    expect(images[0].url).toBe(image(1).url);
  });

  it('treats the same blob under a rotated signature as one entry', () => {
    const base = image(1).url;
    recentSourceImagesStore.record([{ ...image(1), url: `${base}?sig=old&exp=2027-01-01` }]);
    recentSourceImagesStore.record([{ ...image(1), url: `${base}?sig=new&exp=2028-01-01` }]);

    const { images } = useRecentSourceImagesStore.getState();
    expect(images).toHaveLength(1);
    // The newest url wins — the older signature is closer to expiring.
    expect(images[0].url).toBe(`${base}?sig=new&exp=2028-01-01`);
  });

  it('forget matches on the url without its query string', () => {
    const base = image(1).url;
    recentSourceImagesStore.record([{ ...image(1), url: `${base}?sig=abc` }]);
    recentSourceImagesStore.forget([`${base}?sig=totally-different`]);

    expect(useRecentSourceImagesStore.getState().images).toHaveLength(0);
  });

  it('dedupes on READ, so a store persisted with duplicates still renders one tile', () => {
    const base = image(1).url;
    // Bypass record() to simulate state written by an older build.
    useRecentSourceImagesStore.setState({
      images: [
        { url: `${base}?sig=old`, width: 8, height: 8, lastUsedAt: 1 },
        { url: `${base}?sig=new`, width: 8, height: 8, lastUsedAt: 2 },
        { ...image(2), lastUsedAt: 3 },
      ],
    });

    const deduped = dedupeSourceImages(useRecentSourceImagesStore.getState().images);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((i) => i.url)).toEqual([image(2).url, `${base}?sig=new`]);
  });

  it('ignores entries without resolved dimensions', () => {
    recentSourceImagesStore.record([{ url: image(1).url, width: 0, height: 0 }]);
    expect(useRecentSourceImagesStore.getState().images).toHaveLength(0);
  });

  it('replaceUrl swaps a refreshed url without losing its position', () => {
    vi.useFakeTimers();
    recentSourceImagesStore.record([image(1)]);
    vi.advanceTimersByTime(1000);
    recentSourceImagesStore.record([image(2)]);

    recentSourceImagesStore.replaceUrl(image(1).url, 'https://example.com/fresh.jpeg');
    const { images } = useRecentSourceImagesStore.getState();
    expect(images.map((i) => i.url)).toEqual([image(2).url, 'https://example.com/fresh.jpeg']);
  });

  it('forget removes only the named urls', () => {
    recentSourceImagesStore.record([image(1), image(2), image(3)]);
    recentSourceImagesStore.forget([image(2).url]);

    const urls = useRecentSourceImagesStore.getState().images.map((i) => i.url);
    expect(urls).toHaveLength(2);
    expect(urls).not.toContain(image(2).url);
  });
});
