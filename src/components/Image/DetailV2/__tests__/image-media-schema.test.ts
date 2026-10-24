import { describe, expect, it } from 'vitest';
import { buildImageMediaSchema } from '~/components/Image/DetailV2/image-media-schema';
import { NsfwLevel } from '~/server/common/enums';

const user = { username: 'maker', deletedAt: null };
const base = { id: 9, url: 'media-key', width: 512, height: 768, createdAt: new Date(0), user };

function schemaFor(type: 'image' | 'video', nsfwLevel: number) {
  return buildImageMediaSchema({
    image: { ...base, type, nsfwLevel },
    title: 'Posted by maker',
    baseUrl: 'https://civitai.com',
  });
}

describe('image detail media schema', () => {
  it.each([
    ['PG', NsfwLevel.PG],
    ['PG13', NsfwLevel.PG13],
  ])('names the media of a %s video and image', (_, level) => {
    const video = schemaFor('video', level);
    expect(video).toMatchObject({ '@type': 'VideoObject' });
    expect(video?.contentUrl).toMatch(/media-key.*\.mp4$/);
    expect(video?.thumbnailUrl).toMatch(/media-key.*\.jpeg$/);
    expect(video?.creator).toEqual({
      '@type': 'Person',
      name: 'maker',
      url: 'https://civitai.com/user/maker',
    });

    const image = schemaFor('image', level);
    expect(image).toMatchObject({ '@type': 'ImageObject' });
    expect(image?.contentUrl).toContain('media-key');
  });

  // Crawlers and link unfurlers read JSON-LD without passing the page's rating gate.
  it.each([
    ['R', NsfwLevel.R],
    ['X', NsfwLevel.X],
    ['XXX', NsfwLevel.XXX],
    ['PG combined with R', NsfwLevel.PG | NsfwLevel.R],
    ['unrated', 0],
  ])('emits no schema for a %s video or image', (_, level) => {
    expect(schemaFor('video', level)).toBeUndefined();
    expect(schemaFor('image', level)).toBeUndefined();
  });
});

describe('image detail media schema without media', () => {
  it('emits no schema when the media was withheld', () => {
    for (const type of ['image', 'video'] as const)
      expect(
        buildImageMediaSchema({
          image: { ...base, url: null, type, nsfwLevel: NsfwLevel.PG13 },
          title: 'Posted by maker',
        })
      ).toBeUndefined();
  });
});
