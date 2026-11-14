import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import '@mantine/core/styles.css';
import { renderWithProviders } from '../../../../test/component-setup';
import { ServiceOfferingCard } from './ServiceOfferingCard';

vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'blue' }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useBrowsingSettings: <T,>(selector: (state: { autoplayGifs: boolean }) => T) =>
    selector({ autoplayGifs: false }),
  useAutoplayGifs: () => false,
}));
// Which covers are blurred is ImageGuard2's own business; here the card only has to render it.
vi.mock('~/components/ImageGuard/ImageGuard2', () => ({
  ImageGuard2: ({ children }: { children: (safe: boolean) => React.ReactNode }) => (
    <>{children(true)}</>
  ),
}));

// One paragraph: fits in 4 lines when wide, clamps once the container narrows.
const description =
  'Custom character portrait in your style, delivered with layered files. '.repeat(3);

const offering = {
  title: 'Portrait',
  description,
  price: 500,
  deliveryDays: 7,
  revisionsIncluded: 1,
  maxNsfwLevel: 1,
};

const showMore = () =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Show more');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ServiceOfferingCard', () => {
  test('Show more appears when the card narrows after mount', async () => {
    await page.viewport(1280, 900);
    renderWithProviders(
      <div id="holder" style={{ width: 900 }}>
        <ServiceOfferingCard offering={offering} />
      </div>
    );
    await sleep(300);
    expect(showMore()).toBeUndefined();

    document.getElementById('holder')!.style.width = '220px';
    await expect.poll(showMore, { timeout: 2000 }).toBeTruthy();
  });

  test('shows the cover above the title when the offering has one', async () => {
    const cover = {
      id: 7,
      name: 'cover.png',
      url: '00000000-0000-0000-0000-000000000007',
      nsfwLevel: 1,
      hash: null,
      userId: 1,
      type: 'image' as const,
      width: 1600,
      height: 900,
      metadata: null,
    };
    renderWithProviders(
      <div id="with-cover">
        <ServiceOfferingCard offering={{ ...offering, coverImage: cover }} />
      </div>
    );
    renderWithProviders(
      <div id="without-cover">
        <ServiceOfferingCard offering={offering} />
      </div>
    );
    await expect
      .poll(() => document.querySelector(`#with-cover img[src*="${cover.url}"]`), { timeout: 2000 })
      .toBeTruthy();
    expect(document.querySelector('#without-cover img')).toBeNull();
  });
});
