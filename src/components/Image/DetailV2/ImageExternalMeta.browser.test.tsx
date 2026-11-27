import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { ImageExternalMeta } from './ImageExternalMeta';
import { installTrpcWire, renderWithTrpcWire } from '../../../../test/trpcWireHarness';

// The harness mounts the real AppProvider on this page's host, with civitai.red as another of ours.
let wire: ReturnType<typeof installTrpcWire> | undefined;
afterEach(() => wire?.restore());

describe('ImageExternalMeta', () => {
  test('opens a link to another of our sites on the site being read, others as written', async () => {
    wire = installTrpcWire({
      'image.getGenerationData': () => ({
        external: {
          source: { name: 'Studio', homepage: 'https://example.org/' },
          referenceUrl: 'https://civitai.red/images/1',
          createUrl: 'https://example.org/create',
        },
      }),
    });
    const screen = await renderWithTrpcWire(<ImageExternalMeta imageId={1} />, {
      viewer: { id: 1, username: 'ann' },
      flags: {},
    });
    await expect.element(page.getByText('External data')).toBeInTheDocument();
    const hrefs = [...screen.container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      'https://example.org/',
      `https://${window.location.host}/images/1`,
      'https://example.org/create',
    ]);
  });
});
