import { describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../test/component-setup';
import type * as AppProviderModule from '~/providers/AppProvider';

// The real `useCurrentDomainHref` runs against a reader on civitai.red.
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AppProviderModule>()),
  useMaybeAppContext: () => ({
    host: 'civitai.red',
    serverDomains: {
      blue: { primary: 'civitai.com', aliases: [] },
      red: { primary: 'civitai.red', aliases: [] },
      green: { primary: 'civitai.green', aliases: [] },
    },
  }),
}));

const { DomainLinkIcons } = await import('~/components/DomainIcon/DomainLinkIcons');

async function hrefsFor(urls: string[]) {
  const screen = await renderWithProviders(
    <div data-testid="links">
      <DomainLinkIcons links={urls.map((url) => ({ url }))} size={32} iconSize={20} />
    </div>
  );
  return [...screen.container.querySelectorAll('[data-testid="links"] a')].map((a) =>
    a.getAttribute('href')
  );
}

describe('DomainLinkIcons on civitai.red', () => {
  test('opens a link to another of our sites on the site being read', async () => {
    expect(await hrefsFor(['https://civitai.com/user/ann'])).toEqual([
      'https://civitai.red/user/ann',
    ]);
  });

  test('leaves third-party links and a bare homepage link as written', async () => {
    const urls = ['https://github.com/ann', 'https://civitai.com'];
    expect((await hrefsFor(urls)).sort()).toEqual([...urls].sort());
  });
});
