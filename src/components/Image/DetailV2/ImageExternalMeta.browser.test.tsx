import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as AppProviderModule from '~/providers/AppProvider';
import type * as Trpc from '~/utils/trpc';

vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AppProviderModule>()),
  useMaybeAppContext: () => ({
    host: 'civitai.red',
    serverDomains: {
      blue: { primary: 'civitai.com', aliases: [] },
      red: { primary: 'civitai.red', aliases: [] },
    },
  }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  // `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'image.getGenerationData': {
        useQuery: () => ({
          data: {
            external: {
              source: { name: 'Studio', homepage: 'https://example.org/' },
              referenceUrl: 'https://civitai.com/images/1',
              createUrl: 'https://example.org/create',
            },
          },
        }),
      },
    }),
  };
});

const { ImageExternalMeta } = await import('./ImageExternalMeta');
const { renderWithProviders } = await import('../../../../test/component-setup');

describe('ImageExternalMeta on civitai.red', () => {
  test('opens a link to another of our sites on the site being read, others as written', async () => {
    const screen = await renderWithProviders(<ImageExternalMeta imageId={1} />);
    await expect.element(page.getByText('External data')).toBeInTheDocument();
    const hrefs = [...screen.container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      'https://example.org/',
      'https://civitai.red/images/1',
      'https://example.org/create',
    ]);
  });
});
