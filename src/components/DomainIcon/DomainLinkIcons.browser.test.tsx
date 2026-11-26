import { afterEach, describe, expect, test } from 'vitest';
import { DomainLinkIcons } from '~/components/DomainIcon/DomainLinkIcons';
import { installTrpcWire, renderWithTrpcWire } from '../../../test/trpcWireHarness';

// The harness mounts the real AppProvider on this page's host, with civitai.red as another of ours.
let wire: ReturnType<typeof installTrpcWire> | undefined;
afterEach(() => wire?.restore());

async function hrefsFor(urls: string[]) {
  wire = installTrpcWire({});
  const screen = await renderWithTrpcWire(
    <div data-testid="links">
      <DomainLinkIcons links={urls.map((url) => ({ url }))} size={32} iconSize={20} />
    </div>,
    { viewer: { id: 1, username: 'ann' }, flags: {} }
  );
  return [...screen.container.querySelectorAll('[data-testid="links"] a')].map((a) =>
    a.getAttribute('href')
  );
}

describe('DomainLinkIcons', () => {
  test('opens a link to another of our sites on the site being read', async () => {
    expect(await hrefsFor(['https://civitai.red/user/ann'])).toEqual([
      `https://${window.location.host}/user/ann`,
    ]);
  });

  test('leaves third-party links and a bare homepage link as written', async () => {
    const urls = ['https://github.com/ann', 'https://civitai.red'];
    expect((await hrefsFor(urls)).sort()).toEqual([...urls].sort());
  });
});
