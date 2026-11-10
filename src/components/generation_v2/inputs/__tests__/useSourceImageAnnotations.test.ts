// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { UNMARKED_SOURCE_IMAGE_HINT } from '~/shared/constants/mature-source.constants';
import type { ImageStatusAnnotation } from '../ImageUploadMultipleInput';
import { useSourceImageAnnotations } from '../useSourceImageAnnotations';

/**
 * The AI Meta chip warns every user, before they generate, that a source image without
 * generation metadata may cap the run at PG-13. It was once moderators only.
 */
const withMeta = new Set(['https://img/with-meta.png']);

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false }),
}));
vi.mock('~/utils/file-utils', () => ({
  fetchBlobAsFile: async (url: string) => new File([''], url),
}));
vi.mock('~/utils/metadata', () => ({
  ExifParser: async (file: File) => ({
    getMetadata: async () => (withMeta.has(file.name) ? { prompt: 'a cat' } : {}),
    isMadeOnSite: () => false,
  }),
}));

async function annotate(
  urls: string[],
  graphAnnotations?: (ImageStatusAnnotation | null)[]
): Promise<(ImageStatusAnnotation | null)[] | undefined> {
  const images = urls.map((url) => ({ url }));
  let result: (ImageStatusAnnotation | null)[] | undefined;
  function Probe() {
    result = useSourceImageAnnotations(images, graphAnnotations);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe)));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  act(() => root.unmount());
  return result;
}

describe('useSourceImageAnnotations', () => {
  it('shows a non-moderator whether each source image carries AI metadata', async () => {
    const result = await annotate(['https://img/with-meta.png', 'https://img/bare.png']);

    expect(result?.map((a) => a?.label)).toEqual(['AI Meta', 'No AI Meta']);
    expect(result?.[1]?.tooltip).toBe(UNMARKED_SOURCE_IMAGE_HINT);
  });

  it("lets the graph's own annotation win over the metadata chip", async () => {
    const upscale = { label: 'Upscale', color: 'blue' } as ImageStatusAnnotation;
    const result = await annotate(['https://img/bare.png'], [upscale]);

    expect(result).toEqual([upscale]);
  });
});
