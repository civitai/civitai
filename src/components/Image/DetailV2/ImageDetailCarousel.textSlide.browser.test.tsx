import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import type { DetailText } from '~/components/Image/Detail/detail-items';

vi.mock('~/components/ImageGuard/ImageGuard2', async (o) => ({
  ...(await o<object>()),
  ImageGuardContent: ({ children }: { children: (safe: boolean) => JSX.Element }) => children(true),
}));
vi.mock('~/components/RenderHtml/RenderHtml', () => ({
  RenderHtml: ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy({}),
}));

import '~/styles/globals.css';
import { renderWithProviders } from '../../../../test/component-setup';
import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';

// One word wider than a phone's card can hold.
const text: DetailText = {
  id: 7,
  postId: 5,
  index: 0,
  nsfwLevel: 1,
  content: '<p>Pneumonoultramicroscopicsilicovolcanoconiosis</p>',
};

describe('a text slide on a phone-width stage', () => {
  test('stays the width of the stage, with its card centred inside it', async () => {
    await page.viewport(390, 844);
    renderWithProviders(
      // As in ImageDetail2: the carousel fills a column.
      <div style={{ width: 390, height: 600, display: 'flex', flexDirection: 'column' }}>
        <ImageDetailCarousel
          images={[]}
          items={[{ type: 'text', key: 'txt:7', text }]}
          index={0}
          canNavigate={false}
          next={() => undefined}
          previous={() => undefined}
        />
      </div>
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="text-slide"] p')).not.toBeNull()
    );
    const stage = document.querySelector('.touch-pan-y')!.getBoundingClientRect();
    const slideEl = document.querySelector('[data-testid="text-slide"]')!;
    const slide = slideEl.getBoundingClientRect();
    const card = slideEl.lastElementChild!.getBoundingClientRect();
    expect(stage.width).toBe(390);
    expect([slide.left, slide.right]).toEqual([stage.left, stage.right]);
    expect(card.right).toBeLessThanOrEqual(stage.right);
    expect(Math.abs(card.left - stage.left - (stage.right - card.right))).toBeLessThan(1);
  });
});
