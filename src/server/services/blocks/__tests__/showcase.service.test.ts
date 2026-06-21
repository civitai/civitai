import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the showcase service. The interesting surface is the meta
 * extractor (lots of historical shapes for Image.meta in the wild) and
 * the de-dupe + reaction-sort pass.
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    imageResourceNew: { findMany: vi.fn() },
    // Reaction counts now come from a raw query (the reactionCount-is-NULL P2032
    // fix), not the typed metrics relation. The default implementation in
    // beforeEach derives the AllTime ImageMetric rows from whatever findMany
    // returned, reading the per-image count off the test's `metrics` fixture —
    // so the existing imageRow(...) call sites keep working unchanged.
    $queryRaw: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead }));
// Prisma.join is used to build the raw reactionCount query's IN-list. The test
// env's generated client doesn't expose it, and the $queryRaw mock ignores the
// SQL anyway, so a passthrough is all we need.
vi.mock('@prisma/client', () => ({ Prisma: { join: (ids: unknown[]) => ids } }));
// Mock getEdgeUrl as identity so tests assert against the input urls.
vi.mock('~/client-utils/cf-images-utils', () => ({
  getEdgeUrl: (src: string) => src,
}));

import { getModelShowcaseImages } from '../showcase.service';

beforeEach(() => {
  mockDbRead.imageResourceNew.findMany.mockReset();
  mockDbRead.$queryRaw.mockReset();
  // Derive the AllTime ImageMetric rows from the last findMany result. An image
  // whose fixture has `metrics: []` (or no count) is omitted → the service
  // treats it as 0 reactions, exercising the null-tolerant fallback.
  mockDbRead.$queryRaw.mockImplementation(async () => {
    const last = mockDbRead.imageResourceNew.findMany.mock.results.at(-1);
    const rows: Array<{ image?: { id: number; metrics?: Array<{ reactionCount?: number }> } }> =
      last && last.type === 'return' ? await last.value : [];
    const seen = new Set<number>();
    const out: Array<{ imageId: number; reactionCount: number }> = [];
    for (const r of rows) {
      const img = r?.image;
      if (!img || seen.has(img.id)) continue;
      seen.add(img.id);
      const rc = img.metrics?.[0]?.reactionCount;
      if (rc != null) out.push({ imageId: img.id, reactionCount: rc });
    }
    return out;
  });
});

function imageRow(
  id: number,
  reactions: number,
  meta: unknown = {},
  over: Record<string, unknown> = {}
) {
  return {
    image: {
      id,
      url: `https://cdn/${id}.png`,
      width: 1024,
      height: 1024,
      meta,
      nsfwLevel: 1,
      metrics: [{ reactionCount: reactions }],
      ...over,
    },
  };
}

describe('getModelShowcaseImages', () => {
  it('orders by reactionCount desc and caps at 6', async () => {
    mockDbRead.imageResourceNew.findMany.mockResolvedValue([
      imageRow(1, 5),
      imageRow(2, 50),
      imageRow(3, 10),
      imageRow(4, 100),
      imageRow(5, 1),
      imageRow(6, 30),
      imageRow(7, 200),
      imageRow(8, 15),
    ]);
    const result = await getModelShowcaseImages(99);
    // Reaction counts: 7=200, 4=100, 2=50, 6=30, 8=15, 3=10, 1=5, 5=1.
    // Top 6 = [7, 4, 2, 6, 8, 3]; 1 and 5 fall off the cap.
    expect(result.map((i) => i.id)).toEqual([7, 4, 2, 6, 8, 3]);
  });

  it('de-dupes images that appear in multiple resource rows', async () => {
    mockDbRead.imageResourceNew.findMany.mockResolvedValue([
      imageRow(1, 10), // showed up under modelVersionId=99 directly
      imageRow(1, 10), // and also linked through a LoRA from the same model
      imageRow(2, 5),
    ]);
    const result = await getModelShowcaseImages(99);
    expect(result.map((i) => i.id)).toEqual([1, 2]);
  });

  it('falls back to 0 reactions when the image has no AllTime metric row', async () => {
    mockDbRead.imageResourceNew.findMany.mockResolvedValue([
      imageRow(1, 0, {}, { metrics: [] }), // no metric → treated as 0
      imageRow(2, 5),
    ]);
    const result = await getModelShowcaseImages(99);
    expect(result.map((i) => i.id)).toEqual([2, 1]);
  });

  it('returns empty array when no images match', async () => {
    mockDbRead.imageResourceNew.findMany.mockResolvedValue([]);
    const result = await getModelShowcaseImages(99);
    expect(result).toEqual([]);
  });

  // NsfwLevel bitwise flags (mirrors src/server/common/enums.ts):
  //   PG = 1, PG13 = 2, R = 4, X = 8, XXX = 16, Blocked = 32.
  // Anon is forced to the platform public level = PG = 1 (matches the model-page
  // gallery's anon gate); SFW (the logged-in fallback) = PG | PG13 = 3.
  const PG = 1;
  const PG13 = 2;
  const R = 4;
  const X = 8;
  const XXX = 16;
  const Blocked = 32;

  describe('browsing-level filtering (security: NSFW leak into publisher iframe)', () => {
    it('anon viewer (no viewer arg) gets only public (PG) images — PG13+NSFW dropped', async () => {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([
        imageRow(1, 100, {}, { nsfwLevel: PG }),
        imageRow(2, 90, {}, { nsfwLevel: PG13 }),
        imageRow(3, 80, {}, { nsfwLevel: R }),
        imageRow(4, 70, {}, { nsfwLevel: X }),
        imageRow(5, 60, {}, { nsfwLevel: XXX }),
      ]);
      // No viewer → anon → public only (PG). PG13 is excluded too — anon must
      // not see in the iframe a level the model-page gallery wouldn't show them.
      const result = await getModelShowcaseImages(99);
      expect(result.map((i) => i.id)).toEqual([1]);
    });

    it('anon viewer cannot widen via a passed browsingLevel (forced public/PG)', async () => {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([
        imageRow(1, 100, {}, { nsfwLevel: PG }),
        imageRow(2, 95, {}, { nsfwLevel: PG13 }),
        imageRow(3, 90, {}, { nsfwLevel: X }),
        imageRow(4, 80, {}, { nsfwLevel: XXX }),
      ]);
      // userId null but a wide browsingLevel requested — must be ignored; even
      // PG13 is dropped (anon is capped to public/PG, not SFW).
      const result = await getModelShowcaseImages(99, {
        userId: null,
        browsingLevel: PG | PG13 | R | X | XXX,
      });
      expect(result.map((i) => i.id)).toEqual([1]);
    });

    it('NSFW-disabled logged-in viewer (SFW level) is filtered to SFW only', async () => {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([
        imageRow(1, 100, {}, { nsfwLevel: PG }),
        imageRow(2, 90, {}, { nsfwLevel: PG13 }),
        imageRow(3, 80, {}, { nsfwLevel: R }),
        imageRow(4, 70, {}, { nsfwLevel: X }),
      ]);
      const result = await getModelShowcaseImages(99, {
        userId: 42,
        browsingLevel: PG | PG13,
      });
      expect(result.map((i) => i.id)).toEqual([1, 2]);
    });

    it('logged-in viewer with higher browsing levels gets the NSFW images', async () => {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([
        imageRow(1, 100, {}, { nsfwLevel: PG }),
        imageRow(2, 90, {}, { nsfwLevel: R }),
        imageRow(3, 80, {}, { nsfwLevel: X }),
        imageRow(4, 70, {}, { nsfwLevel: XXX }),
      ]);
      // domain:'red' so the color-domain ceiling is all-levels and this test
      // isolates the VIEWER-level dimension (the domain clamp is covered in the
      // dedicated suite below); without it the SFW fail-closed default would
      // mask the requested-level pass-through.
      const result = await getModelShowcaseImages(99, {
        userId: 42,
        browsingLevel: PG | PG13 | R | X | XXX,
        domain: 'red',
      });
      // All intersect the requested level → all returned (reaction order).
      expect(result.map((i) => i.id)).toEqual([1, 2, 3, 4]);
    });

    it('logged-in viewer sees only the levels they requested (R but not X)', async () => {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([
        imageRow(1, 100, {}, { nsfwLevel: PG }),
        imageRow(2, 90, {}, { nsfwLevel: R }),
        imageRow(3, 80, {}, { nsfwLevel: X }),
      ]);
      // domain:'red' isolates the viewer-level dimension (see note above).
      const result = await getModelShowcaseImages(99, {
        userId: 42,
        browsingLevel: PG | PG13 | R,
        domain: 'red',
      });
      expect(result.map((i) => i.id)).toEqual([1, 2]);
    });

    it('logged-in viewer with no/empty browsingLevel falls back to SFW (safe default)', async () => {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([
        imageRow(1, 100, {}, { nsfwLevel: PG13 }),
        imageRow(2, 90, {}, { nsfwLevel: X }),
      ]);
      const result = await getModelShowcaseImages(99, { userId: 42 });
      expect(result.map((i) => i.id)).toEqual([1]);
    });

    it('Blocked is stripped from a requested level (onlySelectableLevels)', async () => {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([
        imageRow(1, 100, {}, { nsfwLevel: PG }),
        imageRow(2, 90, {}, { nsfwLevel: Blocked }),
      ]);
      // Even if a caller requests Blocked, it must not surface Blocked content.
      const result = await getModelShowcaseImages(99, {
        userId: 42,
        browsingLevel: PG | Blocked,
      });
      expect(result.map((i) => i.id)).toEqual([1]);
    });

    it('unrated images (nsfwLevel = 0) are never surfaced, even to a wide viewer', async () => {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([
        imageRow(1, 100, {}, { nsfwLevel: 0 }),
        imageRow(2, 90, {}, { nsfwLevel: PG }),
      ]);
      const result = await getModelShowcaseImages(99, {
        userId: 42,
        browsingLevel: PG | PG13 | R | X | XXX,
      });
      expect(result.map((i) => i.id)).toEqual([2]);
    });

    it('filters by nsfwLevel BEFORE the MAX cap so SFW images are not starved', async () => {
      // 7 NSFW images with the highest reactions, then 6 SFW ones. A naive
      // "slice then filter" would return [] for a SFW viewer; filtering first
      // must yield the 6 SFW images.
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([
        imageRow(101, 1000, {}, { nsfwLevel: X }),
        imageRow(102, 999, {}, { nsfwLevel: X }),
        imageRow(103, 998, {}, { nsfwLevel: X }),
        imageRow(104, 997, {}, { nsfwLevel: X }),
        imageRow(105, 996, {}, { nsfwLevel: X }),
        imageRow(106, 995, {}, { nsfwLevel: X }),
        imageRow(107, 994, {}, { nsfwLevel: X }),
        imageRow(1, 50, {}, { nsfwLevel: PG }),
        imageRow(2, 40, {}, { nsfwLevel: PG }),
        imageRow(3, 30, {}, { nsfwLevel: PG }),
        imageRow(4, 20, {}, { nsfwLevel: PG }),
        imageRow(5, 10, {}, { nsfwLevel: PG }),
        imageRow(6, 5, {}, { nsfwLevel: PG }),
      ]);
      // anon → public (PG). The 7 high-reaction X images must be filtered out
      // BEFORE the 6-image cap, so the lower-reaction PG images aren't starved.
      const result = await getModelShowcaseImages(99);
      expect(result.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  describe('color-domain ceiling (security: mature thumbnail leak on a SFW domain)', () => {
    const wideRows = [
      imageRow(1, 100, {}, { nsfwLevel: PG }),
      imageRow(2, 90, {}, { nsfwLevel: PG13 }),
      imageRow(3, 80, {}, { nsfwLevel: R }),
      imageRow(4, 70, {}, { nsfwLevel: X }),
      imageRow(5, 60, {}, { nsfwLevel: XXX }),
    ];

    it('green domain clamps a viewer requesting browsingLevel:31 to SFW (no R/X/XXX)', async () => {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([...wideRows]);
      // Logged-in viewer asks for everything (PG|PG13|R|X|XXX = 31) but is on a
      // green (SFW) domain — the ceiling intersection drops R/X/XXX so no mature
      // thumbnail URL or its prompt/seed meta reaches the iframe.
      const result = await getModelShowcaseImages(99, {
        userId: 42,
        browsingLevel: PG | PG13 | R | X | XXX,
        domain: 'green',
      });
      expect(result.map((i) => i.id)).toEqual([1, 2]);
    });

    it('blue domain (App-Blocks SFW) also clamps browsingLevel:31 to SFW', async () => {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([...wideRows]);
      const result = await getModelShowcaseImages(99, {
        userId: 42,
        browsingLevel: PG | PG13 | R | X | XXX,
        domain: 'blue',
      });
      // blue is SFW for App Blocks (mirrors the generation clamp) → mature dropped.
      expect(result.map((i) => i.id)).toEqual([1, 2]);
    });

    it('red domain leaves the requested level unclamped (mature thumbnails returned)', async () => {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([...wideRows]);
      const result = await getModelShowcaseImages(99, {
        userId: 42,
        browsingLevel: PG | PG13 | R | X | XXX,
        domain: 'red',
      });
      expect(result.map((i) => i.id)).toEqual([1, 2, 3, 4, 5]);
    });

    it('unknown/missing domain fails closed to SFW for a wide-requesting viewer', async () => {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([...wideRows]);
      // No domain passed (or an unrecognized one) → ceiling fails closed to SFW,
      // so even a logged-in browsingLevel:31 viewer never sees R/X/XXX.
      const result = await getModelShowcaseImages(99, {
        userId: 42,
        browsingLevel: PG | PG13 | R | X | XXX,
      });
      expect(result.map((i) => i.id)).toEqual([1, 2]);
    });

    it('anon on red domain is still capped to public/PG (ceiling never widens anon)', async () => {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([...wideRows]);
      // The ceiling intersection only ever tightens; anon stays at public (PG)
      // even on red, since public ⊆ red-ceiling.
      const result = await getModelShowcaseImages(99, {
        userId: null,
        browsingLevel: PG | PG13 | R | X | XXX,
        domain: 'red',
      });
      expect(result.map((i) => i.id)).toEqual([1]);
    });
  });

  // LOW-1: the showcase clamp must fail closed for an UNRESOLVED host
  // independent of how `domainBrowsingCeiling` happens to map 'blue' today.
  // The router passes the RAW `getRequestDomainColor(req)` (→ `undefined` for an
  // unresolved host) rather than `ctx.domain` (which is `?? 'blue'`-defaulted in
  // createContext). If, instead, the showcase rode on the 'blue'-defaulted
  // value, the moment the platform flips blue→mature in `domainBrowsingCeiling`
  // an unresolved host would silently turn this fail-closed read into a
  // fail-OPEN one. This suite stubs the ceiling so blue→mature and proves an
  // `undefined` domain still clamps to SFW — i.e. the fix does NOT depend on
  // blue's value.
  describe('LOW-1: undefined domain fails closed independent of the blue ceiling', () => {
    const wideRows = [
      imageRow(1, 100, {}, { nsfwLevel: PG }),
      imageRow(2, 90, {}, { nsfwLevel: PG13 }),
      imageRow(3, 80, {}, { nsfwLevel: R }),
      imageRow(4, 70, {}, { nsfwLevel: X }),
      imageRow(5, 60, {}, { nsfwLevel: XXX }),
    ];

    it('undefined domain stays SFW even when blue would map to all-levels', async () => {
      // Stub the SINGLE source of truth so blue (and only blue) maps to the
      // all-levels ceiling — simulating a future site-wide blue→mature flip.
      // `undefined` must still fail closed to SFW: had the router passed the
      // 'blue'-defaulted ctx.domain, this viewer would now see R/X/XXX.
      const constants = await import('~/shared/constants/browsingLevel.constants');
      const spy = vi
        .spyOn(constants, 'domainBrowsingCeiling')
        .mockImplementation((color) => {
          if (color === 'blue' || color === 'red') return constants.allBrowsingLevelsFlag;
          if (color == null) return constants.sfwBrowsingLevelsFlag; // fail closed
          return constants.sfwBrowsingLevelsFlag;
        });
      try {
        mockDbRead.imageResourceNew.findMany.mockResolvedValue([...wideRows]);
        // Unresolved host → raw color undefined → passed through as undefined.
        const undefinedResult = await getModelShowcaseImages(99, {
          userId: 42,
          browsingLevel: PG | PG13 | R | X | XXX,
          domain: undefined,
        });
        expect(undefinedResult.map((i) => i.id)).toEqual([1, 2]); // SFW only

        // Control: explicit blue, under the SAME stub, WOULD widen to mature —
        // proving the undefined-fails-closed result above is not an artifact of
        // the stub being inert (i.e. the blue default would have been a leak).
        mockDbRead.imageResourceNew.findMany.mockResolvedValue([...wideRows]);
        const blueResult = await getModelShowcaseImages(99, {
          userId: 42,
          browsingLevel: PG | PG13 | R | X | XXX,
          domain: 'blue',
        });
        expect(blueResult.map((i) => i.id)).toEqual([1, 2, 3, 4, 5]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('meta extraction', () => {
    async function getFirstMeta(meta: unknown) {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([imageRow(1, 10, meta)]);
      const [first] = await getModelShowcaseImages(99);
      return first;
    }

    it('pulls camelCase fields from a typical orchestrator-shaped meta', async () => {
      const result = await getFirstMeta({
        prompt: 'a cat',
        negativePrompt: 'blurry',
        cfgScale: 7,
        steps: 25,
        seed: 12345,
        sampler: 'Euler',
      });
      expect(result).toMatchObject({
        prompt: 'a cat',
        negativePrompt: 'blurry',
        cfgScale: 7,
        steps: 25,
        seed: 12345,
        sampler: 'Euler',
      });
    });

    it('accepts AUTOMATIC1111-style PascalCase + space-separated keys', async () => {
      const result = await getFirstMeta({
        prompt: 'a cat',
        'Negative prompt': 'blurry',
        'CFG scale': '7.5', // numeric string from older meta dumps
        Steps: 30,
        Seed: 999,
        Sampler: 'DPM++ 2M Karras',
      });
      expect(result.negativePrompt).toBe('blurry');
      expect(result.cfgScale).toBe(7.5);
      expect(result.steps).toBe(30);
      expect(result.seed).toBe(999);
      expect(result.sampler).toBe('DPM++ 2M Karras');
    });

    it('rejects out-of-range / malformed values rather than passing them through', async () => {
      const result = await getFirstMeta({
        prompt: '   ', // whitespace-only → null
        cfgScale: 999, // out of range
        steps: 3.5, // non-int
        seed: 'not a number',
        sampler: 42, // wrong type
      });
      expect(result.prompt).toBeNull();
      expect(result.cfgScale).toBeNull();
      expect(result.steps).toBeNull();
      expect(result.seed).toBeNull();
      expect(result.sampler).toBeNull();
    });

    it('returns all-null meta when Image.meta is null/missing/non-object', async () => {
      const a = await getFirstMeta(null);
      const b = await getFirstMeta('not an object');
      expect(a.prompt).toBeNull();
      expect(a.cfgScale).toBeNull();
      expect(b.prompt).toBeNull();
      expect(b.sampler).toBeNull();
    });

    it('prefers meta-recorded width/height over the image file dims (post-upscale case)', async () => {
      // The image was generated at 832x1216 and upscaled offline to 2496x3648
      // before being uploaded. Image.width/Image.height reflect the upscale.
      // The block should generate at the original 832x1216 — generating at
      // the post-upscale dims (~3x area) diverges noticeably even with all
      // other params identical (real-world case: 8753561-20260525223849768).
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([
        imageRow(
          7,
          10,
          { prompt: 'goth', width: 832, height: 1216 },
          { width: 2496, height: 3648 }
        ),
      ]);
      const [first] = await getModelShowcaseImages(99);
      expect(first.width).toBe(832);
      expect(first.height).toBe(1216);
    });

    it('falls back to image file dims when meta has no width/height', async () => {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([
        imageRow(8, 10, { prompt: 'a cat' }, { width: 1024, height: 1024 }),
      ]);
      const [first] = await getModelShowcaseImages(99);
      expect(first.width).toBe(1024);
      expect(first.height).toBe(1024);
    });
  });
});
