import { describe, expect, it } from 'vitest';
import { civitaiHostedImageUrlSchema } from '~/server/schema/blocks/civitai-image-url';
import {
  buildImagePickerReply,
  capPickedImages,
  IMAGE_PICKER_MULTIPLE_ERROR,
  IMAGE_PICKER_MULTIPLE_MAX,
  IMAGE_PICKER_PUBLIC_ONLY_ERROR,
  IMAGE_PICKER_SOURCES_ERROR,
  jumpDateToBound,
  pickerGridLayout,
  projectGeneratedPick,
  projectPostedPick,
  ratingToLevel,
  removePickedImage,
  resolveImagePickerRequest,
  shouldDropPostedPicks,
  toDateInputValue,
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
      request: {
        requestId: 'rq_1',
        sources: ['posted', 'generated'],
        max: null,
        publicOnly: false,
      },
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
      request: {
        requestId: 'rq_2',
        sources: ['generated', 'posted'],
        max: null,
        publicOnly: false,
      },
    });
    expect(resolveImagePickerRequest({ requestId: 'rq_3', sources: ['generated'] })).toEqual({
      kind: 'open',
      request: { requestId: 'rq_3', sources: ['generated'], max: null, publicOnly: false },
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

  it('opens a publicOnly picker only when publicOnly is true', () => {
    const open = (publicOnly: unknown) =>
      resolveImagePickerRequest({ requestId: 'rq_p', sources: ['posted'], publicOnly });
    expect(open(true)).toEqual({
      kind: 'open',
      request: { requestId: 'rq_p', sources: ['posted'], max: null, publicOnly: true },
    });
    expect(open(false)).toEqual({
      kind: 'open',
      request: { requestId: 'rq_p', sources: ['posted'], max: null, publicOnly: false },
    });
    expect(open(undefined)).toEqual({
      kind: 'open',
      request: { requestId: 'rq_p', sources: ['posted'], max: null, publicOnly: false },
    });
  });

  it('refuses a publicOnly that is not a boolean instead of opening without it', () => {
    for (const publicOnly of [null, 'true', 1, 0, {}, []]) {
      expect(resolveImagePickerRequest({ requestId: 'rq_q', publicOnly })).toEqual({
        kind: 'refuse',
        requestId: 'rq_q',
        error: IMAGE_PICKER_PUBLIC_ONLY_ERROR,
      });
    }
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
    nsfwLevel: 8,
  };

  it('projects a row to the contract shape, without the storage key', () => {
    expect(projectPostedPick(item)).toEqual({
      source: 'posted',
      url: item.url,
      width: 800,
      height: 1417,
      nsfwLevel: 8,
      imageId: 91,
    });
  });

  it('does not send a url that is not an absolute Civitai-hosted https url', () => {
    for (const url of [
      '/a3c1f0de/width=800/a3c1f0de.jpeg',
      'undefined/a3c1f0de/width=800/a3c1f0de.jpeg',
      'http://image.civitai.com/acct/k/width=800/k.jpeg',
      'https://cdn.example/acct/k/width=800/k.jpeg',
      '',
    ]) {
      expect(projectPostedPick({ ...item, url })).toBeNull();
    }
  });

  it('does not send a size below one pixel or a fractional one', () => {
    for (const size of [0, -1, 0.4, 12.5, NaN]) {
      expect(projectPostedPick({ ...item, width: size })).toBeNull();
      expect(projectPostedPick({ ...item, height: size })).toBeNull();
    }
  });
});

describe('ratingToLevel', () => {
  it('maps a known rating and passes a number through', () => {
    expect(ratingToLevel('pg13')).toBe(2);
    expect(ratingToLevel('X')).toBe(8);
    expect(ratingToLevel(16)).toBe(16);
  });

  it('is undefined for an absent or unknown rating', () => {
    for (const rating of [undefined, null, '', 'unrated']) {
      expect(ratingToLevel(rating)).toBeUndefined();
    }
  });

  it('does not resolve a name inherited from the object prototype', () => {
    for (const rating of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(ratingToLevel(rating)).toBeUndefined();
    }
  });
});

describe('projectGeneratedPick', () => {
  const ALL = 31;
  const SFW = 3;
  const output = { type: 'image', url: GENERATED_URL, width: 832, height: 1216, nsfwLevel: 'pg13' };

  it('projects a rated image output, with no imageId', () => {
    const pick = projectGeneratedPick(output, SFW);
    expect(pick).toEqual({
      source: 'generated',
      url: GENERATED_URL,
      width: 832,
      height: 1216,
      nsfwLevel: 2,
    });
    expect(pick).not.toHaveProperty('imageId');
  });

  it('maps each orchestrator rating to its level, whatever its case', () => {
    const level = (nsfwLevel: string | number) =>
      projectGeneratedPick({ ...output, nsfwLevel }, ALL)?.nsfwLevel;
    expect(level('pg')).toBe(1);
    expect(level('PG')).toBe(1);
    expect(level('pg-13')).toBe(2);
    expect(level('r')).toBe(4);
    expect(level('x')).toBe(8);
    expect(level('XXX')).toBe(16);
    expect(level(4)).toBe(4);
  });

  it("offers a level only when the viewer's browsing level includes it", () => {
    const offered = (nsfwLevel: string, browsingLevel: number) =>
      projectGeneratedPick({ ...output, nsfwLevel }, browsingLevel) !== null;
    // PG + PG-13
    expect(offered('pg', 3)).toBe(true);
    expect(offered('r', 3)).toBe(false);
    expect(offered('x', 3)).toBe(false);
    // PG + PG-13 + R
    expect(offered('r', 7)).toBe(true);
    expect(offered('x', 7)).toBe(false);
    // R + X only: a level below the range is not included either
    expect(offered('x', 12)).toBe(true);
    expect(offered('pg', 12)).toBe(false);
    expect(offered('xxx', 31)).toBe(true);
    expect(offered('pg', 0)).toBe(false);
  });

  it('does not offer an output with no rating, even at the widest browsing level', () => {
    for (const nsfwLevel of [undefined, null, '', 'unrated', 'na', 0]) {
      expect(projectGeneratedPick({ ...output, nsfwLevel }, 63)).toBeNull();
    }
    const { nsfwLevel: _omitted, ...unrated } = output;
    expect(projectGeneratedPick(unrated, 63)).toBeNull();
  });

  it('does not resolve a rating through the object prototype', () => {
    for (const nsfwLevel of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(projectGeneratedPick({ ...output, nsfwLevel }, 63)).toBeNull();
    }
  });

  it('does not offer a numeric rating that is not exactly one known level', () => {
    for (const nsfwLevel of [3, 5, 6, 32, 64, 33, 1.5, -1, NaN]) {
      expect(projectGeneratedPick({ ...output, nsfwLevel }, 127)).toBeNull();
    }
  });

  it('offers images only', () => {
    for (const type of ['video', 'audio', 'model3d']) {
      expect(projectGeneratedPick({ ...output, type }, ALL)).toBeNull();
    }
  });

  it('does not offer an output without a whole pixel size', () => {
    for (const size of [undefined, null, 0, -4, 12.5, NaN]) {
      expect(projectGeneratedPick({ ...output, width: size }, ALL)).toBeNull();
      expect(projectGeneratedPick({ ...output, height: size }, ALL)).toBeNull();
    }
  });

  it('does not offer an output that is not on a Civitai image host', () => {
    for (const url of [
      'https://evil.example/v2/consumer/blobs/a.jpeg',
      'http://orchestration.civitai.com/v2/consumer/blobs/a.jpeg',
      'https://evil.example/?x=orchestration.civitai.com',
      'blob:https://civitai.com/abc',
    ]) {
      expect(projectGeneratedPick({ ...output, url }, ALL)).toBeNull();
    }
  });

  it('returns a url a generation sourceImage accepts', () => {
    const pick = projectGeneratedPick(output, ALL);
    expect(civitaiHostedImageUrlSchema.safeParse(pick?.url)).toEqual({
      success: true,
      data: GENERATED_URL,
    });
  });
});

describe('removePickedImage', () => {
  it('removes only the image matching source and url, keeping the order of the rest', () => {
    const generated = { ...posted(2), source: 'generated' as const, imageId: undefined };
    const current = [posted(1), generated, posted(2), posted(3)];
    expect(removePickedImage(current, posted(2))).toEqual([posted(1), generated, posted(3)]);
  });

  it('keeps fields the caller attached to a selection', () => {
    const current = [
      { ...posted(1), thumbnail: 'key-1' },
      { ...posted(2), thumbnail: 'key-2' },
    ];
    expect(removePickedImage(current, posted(1))).toEqual([{ ...posted(2), thumbnail: 'key-2' }]);
  });

  it('returns the same picks when the image is not selected', () => {
    expect(removePickedImage([posted(1)], posted(9))).toEqual([posted(1)]);
  });
});

describe('pickerGridLayout', () => {
  it('fits as many columns as the minimum tile allows and shares the rest of the width', () => {
    // 7 columns of 112 with 6 gaps of 8 need 832: 760 fits 6, each (760 - 40) / 6 = 120 wide.
    expect(pickerGridLayout(760, 112, 8)).toEqual({ columns: 6, tile: 120 });
    // Exactly 3 tiles and 2 gaps: the boundary keeps 3 columns at the minimum size.
    expect(pickerGridLayout(352, 112, 8)).toEqual({ columns: 3, tile: 112 });
    // One pixel short of that drops to 2 wider tiles.
    expect(pickerGridLayout(351, 112, 8)).toEqual({ columns: 2, tile: 171 });
  });

  it('never has fewer than one column, even narrower than a tile or before it is measured', () => {
    expect(pickerGridLayout(90, 112, 8)).toEqual({ columns: 1, tile: 90 });
    expect(pickerGridLayout(0, 112, 8)).toEqual({ columns: 1, tile: 0 });
    expect(pickerGridLayout(-20, 112, 8)).toEqual({ columns: 1, tile: 0 });
  });

  it('a phone-width grid has three columns down to a 320px screen, a desktop one six', () => {
    // Full screen, less the modal padding (2 x 16) and the grid inset (2 x 4).
    expect(pickerGridLayout(320 - 32 - 8)).toEqual({ columns: 3, tile: 88 });
    expect(pickerGridLayout(375 - 32 - 8)).toEqual({ columns: 3, tile: 106 });
    // Just under the narrow threshold, still the phone minimum: 6 columns, not 4.
    expect(pickerGridLayout(599)).toEqual({ columns: 6, tile: 93 });
    // At the threshold the wide minimum applies.
    expect(pickerGridLayout(600)).toEqual({ columns: 4, tile: 144 });
    // The 800px desktop modal, less its padding and the inset.
    expect(pickerGridLayout(800 - 32 - 8)).toEqual({ columns: 6, tile: 120 });
  });
});

describe('jumpDateToBound', () => {
  it('is the last millisecond of the chosen local day', () => {
    const bound = jumpDateToBound('2024-02-29');
    expect(bound).toEqual(new Date(2024, 1, 29, 23, 59, 59, 999));
  });

  it('means no bound for an empty, malformed or impossible date', () => {
    for (const value of ['', '2024-2-9', '2024/02/09', 'yesterday', '2023-02-29', '2024-13-01']) {
      expect(jumpDateToBound(value)).toBeNull();
    }
  });

  it('means no bound for a year still being typed, or any day before 2000', () => {
    for (const value of ['0002-06-30', '0020-06-30', '0202-06-30', '1999-12-30']) {
      expect(jumpDateToBound(value)).toBeNull();
    }
    expect(jumpDateToBound('2000-01-02')).toEqual(new Date(2000, 0, 2, 23, 59, 59, 999));
  });

  it("is the end of the viewer's own day, not UTC's, in a zone ahead of and behind UTC", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Tokyo'; // UTC+9, no DST
      expect(jumpDateToBound('2024-06-30')?.toISOString()).toBe('2024-06-30T14:59:59.999Z');
      // 20:00 UTC on Jun 30 is already Jul 1 in Tokyo.
      expect(toDateInputValue(new Date('2024-06-30T20:00:00.000Z'))).toBe('2024-07-01');

      process.env.TZ = 'America/Los_Angeles'; // UTC-7 in June
      expect(jumpDateToBound('2024-06-30')?.toISOString()).toBe('2024-07-01T06:59:59.999Z');
      expect(toDateInputValue(new Date('2024-07-01T03:00:00.000Z'))).toBe('2024-06-30');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('round-trips with toDateInputValue', () => {
    const day = new Date(2025, 0, 5, 9, 30);
    expect(toDateInputValue(day)).toBe('2025-01-05');
    expect(toDateInputValue(jumpDateToBound(toDateInputValue(day))!)).toBe('2025-01-05');
  });
});

describe('shouldDropPostedPicks', () => {
  const pageA = { items: ['a'] };
  const pageB = { items: ['b'] };

  it('drops when the list is replaced at the same date bound (a browsing-level reset)', () => {
    expect(
      shouldDropPostedPicks(
        { listKey: pageA, bound: undefined },
        { listKey: pageB, bound: undefined }
      )
    ).toBe(true);
    expect(
      shouldDropPostedPicks({ listKey: pageA, bound: 5 }, { listKey: undefined, bound: 5 })
    ).toBe(true);
  });

  it('keeps picks when the list is replaced because the viewer jumped to another date', () => {
    expect(
      shouldDropPostedPicks({ listKey: pageA, bound: undefined }, { listKey: undefined, bound: 5 })
    ).toBe(false);
    expect(shouldDropPostedPicks({ listKey: pageA, bound: 5 }, { listKey: pageB, bound: 7 })).toBe(
      false
    );
    expect(
      shouldDropPostedPicks({ listKey: pageA, bound: 5 }, { listKey: pageB, bound: undefined })
    ).toBe(false);
  });

  it('keeps picks for the first list after a mount, and while the list only gains pages', () => {
    expect(
      shouldDropPostedPicks({ listKey: undefined, bound: 5 }, { listKey: pageA, bound: 5 })
    ).toBe(false);
    expect(shouldDropPostedPicks({ listKey: pageA, bound: 5 }, { listKey: pageA, bound: 5 })).toBe(
      false
    );
  });
});
