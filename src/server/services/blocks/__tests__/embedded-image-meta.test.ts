import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Metadata from '~/utils/metadata';
import type * as Audit from '~/utils/metadata/audit';
import {
  A1111_PARAMETERS,
  pngWithTextChunks,
} from '~/server/services/blocks/__tests__/png-text-chunk.fixture';

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
import { readEmbeddedImageMeta } from '~/server/services/blocks/embedded-image-meta';

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

  it('returns undefined for a truncated ComfyUI graph chunk', async () => {
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

  it('returns undefined when the parse misses its deadline', async () => {
    h.getMetadataOverride = () => new Promise(() => undefined);
    const started = Date.now();
    await expect(
      readEmbeddedImageMeta(await pngWithTextChunks({ parameters: A1111_PARAMETERS }), {
        deadlineMs: 20,
      })
    ).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
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
