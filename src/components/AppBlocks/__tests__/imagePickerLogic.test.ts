import { describe, expect, it } from 'vitest';
import { civitaiHostedImageUrlSchema } from '~/server/schema/blocks/civitai-image-url';
import {
  buildImagePickerReply,
  capPickedImages,
  IMAGE_PICKER_MULTIPLE_ERROR,
  IMAGE_PICKER_MULTIPLE_MAX,
  IMAGE_PICKER_SOURCES_ERROR,
  projectGeneratedPick,
  projectPostedPick,
  resolveImagePickerRequest,
  togglePickedImage,
  type BlockPickedImageInfo,
} from '../imagePickerLogic';

const GENERATED_URL =
  'https://orchestration.civitai.com/v2/consumer/blobs/E8S6FBPH50ENNVF2PD5.jpeg?sig=x&exp=2030-01-01T00:00:00Z';

const posted = (n: number): BlockPickedImageInfo => ({
  source: 'posted',
  url: `https://image.civitai.com/acct/key-${n}/width=1200/key-${n}.jpeg`,
  width: 1200,
  height: 800 + n,
  nsfwLevel: 1,
  imageId: 5000 + n,
});

describe('resolveImagePickerRequest', () => {
  it('drops a payload with no usable requestId', () => {
    for (const raw of [undefined, null, 'x', 7, {}, { requestId: 7 }, { requestId: '' }]) {
      expect(resolveImagePickerRequest(raw)).toEqual({ kind: 'drop' });
    }
  });

  it('opens a single pick over both sources when sources and multiple are omitted', () => {
    expect(resolveImagePickerRequest({ requestId: 'rq_1' })).toEqual({
      kind: 'open',
      request: { requestId: 'rq_1', sources: ['posted', 'generated'], max: null },
    });
  });

  it('keeps the requested sources in the order asked, de-duplicated', () => {
    expect(
      resolveImagePickerRequest({
        requestId: 'rq_2',
        sources: ['generated', 'posted', 'generated'],
      })
    ).toEqual({
      kind: 'open',
      request: { requestId: 'rq_2', sources: ['generated', 'posted'], max: null },
    });
    expect(resolveImagePickerRequest({ requestId: 'rq_3', sources: ['generated'] })).toEqual({
      kind: 'open',
      request: { requestId: 'rq_3', sources: ['generated'], max: null },
    });
  });

  it('refuses sources that are not a non-empty list of known members', () => {
    const invalid = [null, 'posted', {}, [], ['posted', 'liked'], ['Posted'], [1], [null]];
    for (const sources of invalid) {
      expect(resolveImagePickerRequest({ requestId: 'rq_4', sources })).toEqual({
        kind: 'refuse',
        requestId: 'rq_4',
        error: IMAGE_PICKER_SOURCES_ERROR,
      });
    }
  });

  it('accepts multiple.max as a whole number of at least 1', () => {
    expect(resolveImagePickerRequest({ requestId: 'rq_5', multiple: { max: 1 } })).toMatchObject({
      kind: 'open',
      request: { max: 1 },
    });
    expect(resolveImagePickerRequest({ requestId: 'rq_5', multiple: { max: 7 } })).toMatchObject({
      kind: 'open',
      request: { max: 7 },
    });
  });

  it('clamps a multiple.max above the cap to the cap', () => {
    expect(IMAGE_PICKER_MULTIPLE_MAX).toBe(20);
    expect(resolveImagePickerRequest({ requestId: 'rq_6', multiple: { max: 20 } })).toMatchObject({
      request: { max: 20 },
    });
    expect(resolveImagePickerRequest({ requestId: 'rq_6', multiple: { max: 21 } })).toMatchObject({
      request: { max: 20 },
    });
    expect(resolveImagePickerRequest({ requestId: 'rq_6', multiple: { max: 999 } })).toMatchObject({
      request: { max: 20 },
    });
  });

  it('refuses an invalid multiple instead of downgrading it to a single pick', () => {
    const invalid = [
      null,
      true,
      3,
      {},
      { max: 0 },
      { max: -2 },
      { max: 2.5 },
      { max: '3' },
      { max: NaN },
      { max: Infinity },
    ];
    for (const multiple of invalid) {
      expect(resolveImagePickerRequest({ requestId: 'rq_7', multiple })).toEqual({
        kind: 'refuse',
        requestId: 'rq_7',
        error: IMAGE_PICKER_MULTIPLE_ERROR,
      });
    }
  });
});

describe('capPickedImages', () => {
  it('keeps pick order and never returns more than max', () => {
    const picked = [posted(3), posted(1), posted(2), posted(4)];
    expect(capPickedImages(picked, 3)).toEqual([posted(3), posted(1), posted(2)]);
    expect(capPickedImages(picked, 9)).toEqual(picked);
  });

  it('collapses a repeated image onto its first occurrence', () => {
    expect(capPickedImages([posted(1), posted(2), posted(1), posted(3)], 3)).toEqual([
      posted(1),
      posted(2),
      posted(3),
    ]);
  });

  it('treats the same url from two sources as two images', () => {
    const a = { source: 'posted' as const, url: GENERATED_URL };
    const b = { source: 'generated' as const, url: GENERATED_URL };
    expect(capPickedImages([a, b], 5)).toEqual([a, b]);
  });
});

describe('togglePickedImage', () => {
  it('single pick: selects, replaces, and deselects', () => {
    expect(togglePickedImage([], posted(1), null)).toEqual([posted(1)]);
    expect(togglePickedImage([posted(1)], posted(2), null)).toEqual([posted(2)]);
    expect(togglePickedImage([posted(2)], posted(2), null)).toEqual([]);
  });

  it('multi pick: appends in click order while under max', () => {
    expect(togglePickedImage([posted(3)], posted(1), 3)).toEqual([posted(3), posted(1)]);
    expect(togglePickedImage([posted(3), posted(1)], posted(2), 3)).toEqual([
      posted(3),
      posted(1),
      posted(2),
    ]);
  });

  it('multi pick: refuses an image past max, at max 1 as well', () => {
    expect(togglePickedImage([posted(3), posted(1)], posted(2), 2)).toEqual([posted(3), posted(1)]);
    expect(togglePickedImage([posted(3)], posted(1), 1)).toEqual([posted(3)]);
  });

  it('multi pick: a selected image can be removed at max', () => {
    expect(togglePickedImage([posted(3), posted(1)], posted(3), 2)).toEqual([posted(1)]);
  });
});

describe('buildImagePickerReply', () => {
  it('answers a single pick with `selected`', () => {
    expect(buildImagePickerReply({ requestId: 'rq_s', max: null }, [posted(1), posted(2)])).toEqual(
      { requestId: 'rq_s', selected: posted(1) }
    );
  });

  it('answers a dismissed single pick with a bare requestId', () => {
    const reply = buildImagePickerReply({ requestId: 'rq_s', max: null }, []);
    expect(reply).toEqual({ requestId: 'rq_s' });
    expect(Object.keys(reply)).toEqual(['requestId']);
  });

  it('answers a multi pick with `selectedImages`, capped, and never `selected`', () => {
    const reply = buildImagePickerReply({ requestId: 'rq_m', max: 2 }, [
      posted(3),
      posted(1),
      posted(2),
    ]);
    expect(reply).toEqual({ requestId: 'rq_m', selectedImages: [posted(3), posted(1)] });
    expect(reply).not.toHaveProperty('selected');
  });

  it('answers a multi pick of one, and a dismissed multi pick, with a list', () => {
    expect(buildImagePickerReply({ requestId: 'rq_m', max: 1 }, [posted(4)])).toEqual({
      requestId: 'rq_m',
      selectedImages: [posted(4)],
    });
    expect(buildImagePickerReply({ requestId: 'rq_m', max: 5 }, [])).toEqual({
      requestId: 'rq_m',
      selectedImages: [],
    });
  });

  it('sends only the contract fields, and imageId only for a posted pick', () => {
    const noisy = { ...posted(1), key: 'storage-key', meta: { prompt: 'p' } };
    const generated = {
      source: 'generated' as const,
      url: GENERATED_URL,
      width: 832,
      height: 1216,
      nsfwLevel: 2,
      imageId: 77,
    };
    const reply = buildImagePickerReply({ requestId: 'rq_w', max: 5 }, [noisy, generated]);
    expect(reply).toEqual({
      requestId: 'rq_w',
      selectedImages: [
        posted(1),
        { source: 'generated', url: GENERATED_URL, width: 832, height: 1216, nsfwLevel: 2 },
      ],
    });
  });
});

describe('projectPostedPick', () => {
  const item = {
    imageId: 91,
    key: 'a3c1f0de-0000-4000-8000-000000000091',
    url: 'https://image.civitai.com/acct/a3c1f0de-0000-4000-8000-000000000091/width=800/a3c1f0de-0000-4000-8000-000000000091.jpeg',
    width: 800,
    height: 1417,
    nsfwLevel: 2,
  };

  it('projects a pickable row to the contract shape, without the storage key', () => {
    expect(projectPostedPick(item)).toEqual({
      source: 'posted',
      url: item.url,
      width: 800,
      height: 1417,
      nsfwLevel: 2,
      imageId: 91,
    });
  });

  it('accepts every level within the SFW ceiling and nothing above it', () => {
    for (const nsfwLevel of [0, 1, 2, 3]) {
      expect(projectPostedPick({ ...item, nsfwLevel })).not.toBeNull();
    }
    for (const nsfwLevel of [4, 8, 16, 32, 5, 6, 34]) {
      expect(projectPostedPick({ ...item, nsfwLevel })).toBeNull();
    }
  });
});

describe('projectGeneratedPick', () => {
  const output = { type: 'image', url: GENERATED_URL, width: 832, height: 1216, nsfwLevel: 'pg13' };

  it('projects a rated SFW image output, with no imageId', () => {
    const pick = projectGeneratedPick(output);
    expect(pick).toEqual({
      source: 'generated',
      url: GENERATED_URL,
      width: 832,
      height: 1216,
      nsfwLevel: 2,
    });
    expect(pick).not.toHaveProperty('imageId');
  });

  it('maps each SFW orchestrator rating, whatever its case', () => {
    expect(projectGeneratedPick({ ...output, nsfwLevel: 'pg' })?.nsfwLevel).toBe(1);
    expect(projectGeneratedPick({ ...output, nsfwLevel: 'PG' })?.nsfwLevel).toBe(1);
    expect(projectGeneratedPick({ ...output, nsfwLevel: 'pg-13' })?.nsfwLevel).toBe(2);
    expect(projectGeneratedPick({ ...output, nsfwLevel: 1 })?.nsfwLevel).toBe(1);
  });

  it('does not offer an output with no rating', () => {
    for (const nsfwLevel of [undefined, null, '', 'unrated', 'na', 0]) {
      expect(projectGeneratedPick({ ...output, nsfwLevel })).toBeNull();
    }
    const { nsfwLevel: _omitted, ...unrated } = output;
    expect(projectGeneratedPick(unrated)).toBeNull();
  });

  it('does not offer an output rated above the SFW ceiling', () => {
    for (const nsfwLevel of ['r', 'x', 'xxx', 'R', 4, 8, 16, 32]) {
      expect(projectGeneratedPick({ ...output, nsfwLevel })).toBeNull();
    }
  });

  it('offers images only', () => {
    for (const type of ['video', 'audio', 'model3d']) {
      expect(projectGeneratedPick({ ...output, type })).toBeNull();
    }
  });

  it('does not offer an output without a whole pixel size', () => {
    for (const size of [undefined, null, 0, -4, 12.5, NaN]) {
      expect(projectGeneratedPick({ ...output, width: size })).toBeNull();
      expect(projectGeneratedPick({ ...output, height: size })).toBeNull();
    }
  });

  it('does not offer an output that is not on a Civitai image host', () => {
    for (const url of [
      'https://evil.example/v2/consumer/blobs/a.jpeg',
      'http://orchestration.civitai.com/v2/consumer/blobs/a.jpeg',
      'https://evil.example/?x=orchestration.civitai.com',
      'blob:https://civitai.com/abc',
    ]) {
      expect(projectGeneratedPick({ ...output, url })).toBeNull();
    }
  });

  it('returns a url a generation sourceImage accepts', () => {
    const pick = projectGeneratedPick(output);
    expect(civitaiHostedImageUrlSchema.safeParse(pick?.url)).toEqual({
      success: true,
      data: GENERATED_URL,
    });
  });
});
