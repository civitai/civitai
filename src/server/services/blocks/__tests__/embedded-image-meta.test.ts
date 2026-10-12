import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Metadata from '~/utils/metadata';
import type * as Audit from '~/utils/metadata/audit';
import {
  A1111_PARAMETERS,
  COMFY_PROMPT_GRAPH,
  jpegWithUserComment,
  pngWithChunksAfterEnd,
  pngWithTextChunks,
} from '~/server/services/blocks/__tests__/embedded-meta-images.fixture';

const h = vi.hoisted(() => ({
  getMetadataOverride: null as null | ((file: unknown) => Promise<unknown>),
  auditOverride: null as null | ((meta: unknown, nsfw: boolean) => unknown),
}));

vi.mock('~/utils/metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof Metadata>();
  return {
    ...actual,
    getMetadata: vi.fn((file: Parameters<typeof actual.getMetadata>[0]) =>
      h.getMetadataOverride ? h.getMetadataOverride(file) : actual.getMetadata(file)
    ),
  };
});
vi.mock('~/utils/metadata/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof Audit>();
  return {
    ...actual,
    auditMetaData: vi.fn((meta: Parameters<typeof actual.auditMetaData>[0], nsfw: boolean) =>
      h.auditOverride ? h.auditOverride(meta, nsfw) : actual.auditMetaData(meta, nsfw)
    ),
  };
});

import { auditMetaData } from '~/utils/metadata/audit';
import { blockedRegexLazy } from '~/utils/metadata/audit-base';
import sharp from 'sharp';
import {
  EMBEDDED_META_BUDGET,
  metadataRegion,
  readEmbeddedImageMeta,
} from '~/server/services/blocks/embedded-image-meta';

beforeEach(() => {
  h.getMetadataOverride = null;
  h.auditOverride = null;
  vi.mocked(auditMetaData).mockClear();
});

describe('readEmbeddedImageMeta', () => {
  it('reads A1111 `parameters` from a PNG text chunk', async () => {
    const meta = await readEmbeddedImageMeta(
      await pngWithTextChunks({ parameters: A1111_PARAMETERS })
    );
    expect(meta).toMatchObject({
      prompt: 'a lighthouse at dusk, oil painting',
      negativePrompt: 'blurry',
      steps: 24,
      sampler: 'Euler a',
      cfgScale: 6.5,
      seed: 1234567,
    });
  });

  it('reads a ComfyUI `prompt` graph from a PNG text chunk, keeping the graph', async () => {
    const meta = await readEmbeddedImageMeta(
      await pngWithTextChunks({ prompt: COMFY_PROMPT_GRAPH })
    );
    expect(meta).toMatchObject({
      prompt: 'a lighthouse at dusk',
      negativePrompt: 'blurry',
      seed: 7654321,
      steps: 20,
    });
    expect(meta?.comfy).toBeDefined();
  });

  it('reads A1111 parameters from a JPEG EXIF UserComment', async () => {
    const meta = await readEmbeddedImageMeta(await jpegWithUserComment(A1111_PARAMETERS));
    expect(meta).toMatchObject({
      prompt: 'a lighthouse at dusk, oil painting',
      steps: 24,
      seed: 1234567,
    });
  });

  it('returns undefined for a PNG with no generation chunk', async () => {
    await expect(readEmbeddedImageMeta(await pngWithTextChunks({}))).resolves.toBeUndefined();
  });

  it('drops provenance keys spelled in the parameters line and keeps the rest', async () => {
    const meta = await readEmbeddedImageMeta(
      await pngWithTextChunks({
        parameters: `${A1111_PARAMETERS}, Hires upscale: 2, blockUploadedAppId: forged-app, blockPublishedAppId: forged-app`,
      })
    );
    // Positive control: an unknown key from the same line survives, so the parser does emit
    // arbitrary keys and the provenance keys' absence is the strip, not the parser.
    expect(meta).toMatchObject({ prompt: 'a lighthouse at dusk, oil painting' });
    expect(meta && Object.keys(meta)).toContain('Hires upscale');
    expect(meta && 'blockUploadedAppId' in meta).toBe(false);
    expect(meta && 'blockPublishedAppId' in meta).toBe(false);
  });

  it.each([
    ['bytes that are not an image', Buffer.from('definitely not an image file')],
    ['an empty buffer', Buffer.alloc(0)],
  ])('returns undefined, without throwing, for %s', async (_label, bytes) => {
    await expect(readEmbeddedImageMeta(bytes)).resolves.toBeUndefined();
  });

  it('returns undefined for a truncated ComfyUI graph chunk (the parser yields an empty bag)', async () => {
    const bytes = await pngWithTextChunks({ prompt: '{"3":{"class_type":"KSampler","inputs":' });
    await expect(readEmbeddedImageMeta(bytes)).resolves.toBeUndefined();
  });

  it('returns undefined when the parser throws', async () => {
    h.getMetadataOverride = async () => {
      throw new Error('hostile chunk');
    };
    await expect(
      readEmbeddedImageMeta(await pngWithTextChunks({ parameters: A1111_PARAMETERS }))
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the parsed meta is over the 1 MB ceiling', async () => {
    const longPrompt = `a lighthouse ${'very '.repeat(220_000)}detailed`;
    const bytes = await pngWithTextChunks({
      parameters: `${longPrompt}\nSteps: 24, Sampler: Euler a, Seed: 1`,
    });
    await expect(readEmbeddedImageMeta(bytes)).resolves.toBeUndefined();

    // Control: the same shape under the ceiling is kept, so the size is what refused it.
    const shortPrompt = `a lighthouse ${'very '.repeat(100_000)}detailed`;
    const kept = await readEmbeddedImageMeta(
      await pngWithTextChunks({
        parameters: `${shortPrompt}\nSteps: 24, Sampler: Euler a, Seed: 1`,
      })
    );
    expect(kept?.prompt).toBe(shortPrompt);
  });

  it('returns undefined when the prompt contains a term on the real SFW block list', async () => {
    const blocked = blockedRegexLazy()[0].word;
    const bytes = await pngWithTextChunks({
      parameters: `a lighthouse, ${blocked}\nSteps: 24, Sampler: Euler a, Seed: 1`,
    });
    await expect(readEmbeddedImageMeta(bytes)).resolves.toBeUndefined();
    expect(vi.mocked(auditMetaData)).toHaveBeenCalledTimes(1);
  });

  it('audits the prompt against the SFW list and returns undefined when it is blocked', async () => {
    h.auditOverride = () => ({ blockedFor: ['blocked-term'], success: false });
    const meta = await readEmbeddedImageMeta(
      await pngWithTextChunks({ parameters: A1111_PARAMETERS })
    );
    expect(meta).toBeUndefined();
    expect(vi.mocked(auditMetaData)).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a lighthouse at dusk, oil painting' }),
      false
    );
  });
});

function fillerChunks(count: number, bytesEach: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`filler${i}`, 'x'.repeat(bytesEach)])
  );
}

describe('metadata budget (checked before parsing)', () => {
  it('refuses a PNG with more text chunks than the budget, without parsing it', async () => {
    const getMetadataSpy = vi.fn(async () => ({}));
    h.getMetadataOverride = getMetadataSpy;
    const bytes = await pngWithTextChunks({
      parameters: A1111_PARAMETERS,
      ...fillerChunks(EMBEDDED_META_BUDGET.maxMetadataBlocks * 3, 8),
    });
    await expect(readEmbeddedImageMeta(bytes)).resolves.toBeUndefined();
    expect(getMetadataSpy).not.toHaveBeenCalled();
  });

  it('keeps meta from a PNG well under the chunk budget', async () => {
    const bytes = await pngWithTextChunks({
      parameters: A1111_PARAMETERS,
      ...fillerChunks(10, 8),
    });
    await expect(readEmbeddedImageMeta(bytes)).resolves.toMatchObject({
      prompt: 'a lighthouse at dusk, oil painting',
    });
  });

  it('refuses a PNG whose text payload is over the byte budget, and keeps one under it', async () => {
    const over = await pngWithTextChunks({
      parameters: A1111_PARAMETERS,
      ...fillerChunks(1, EMBEDDED_META_BUDGET.maxMetadataBytes + 300_000),
    });
    await expect(readEmbeddedImageMeta(over)).resolves.toBeUndefined();

    const under = await pngWithTextChunks({
      parameters: A1111_PARAMETERS,
      ...fillerChunks(1, 300_000),
    });
    await expect(readEmbeddedImageMeta(under)).resolves.toMatchObject({
      prompt: 'a lighthouse at dusk, oil painting',
    });
  });

  it('rejects a file with hundreds of thousands of text chunks quickly', async () => {
    const bytes = await pngWithTextChunks(fillerChunks(300_000, 4));
    const started = performance.now();
    await expect(readEmbeddedImageMeta(bytes)).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('ignores chunks after IEND: neither parsed into meta nor allowed to cost parse time', async () => {
    const trailingMeta = await pngWithChunksAfterEnd({}, { parameters: A1111_PARAMETERS });
    await expect(readEmbeddedImageMeta(trailingMeta)).resolves.toBeUndefined();

    const trailingFlood = await pngWithChunksAfterEnd(
      { parameters: A1111_PARAMETERS },
      fillerChunks(300_000, 4)
    );
    const started = performance.now();
    await expect(readEmbeddedImageMeta(trailingFlood)).resolves.toMatchObject({
      prompt: 'a lighthouse at dusk, oil painting',
    });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it.each([
    ['PNG', () => pngWithTextChunks({})],
    [
      'JPEG',
      () =>
        sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
          .jpeg()
          .toBuffer(),
    ],
    [
      'WebP',
      () =>
        sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
          .webp()
          .toBuffer(),
    ],
  ])('passes a plain %s', async (_label, make) => {
    expect(metadataRegion(await make())).not.toBeNull();
  });

  it.each([
    [
      'GIF',
      () =>
        sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
          .gif()
          .toBuffer(),
    ],
    [
      'a PNG cut off mid-chunk',
      async () => (await pngWithTextChunks({ parameters: A1111_PARAMETERS })).subarray(0, 60),
    ],
  ])('fails %s', async (_label, make) => {
    expect(metadataRegion(await make())).toBeNull();
  });
});
