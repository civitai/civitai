import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { PostPublishedWithApp } from '~/components/Post/Detail/PostPublishedWithApp';
import { LOADABLE_IMAGE_DATA_URI } from '../../../../test/component-setup';
import { installTrpcWire, renderWithTrpcWire } from '../../../../test/trpcWireHarness';

// The harness mounts the real AppProvider on this page's host, with civitai.red as another of ours.
let wire: ReturnType<typeof installTrpcWire> | undefined;
afterEach(() => wire?.restore());

test('opens an off-site item on another of our sites on the site being read', async () => {
  wire = installTrpcWire({ 'appListings.getAppCard': () => null });
  await renderWithTrpcWire(
    <PostPublishedWithApp
      app={{
        slug: 'custom-generators',
        name: 'Custom Generators',
        iconUrl: LOADABLE_IMAGE_DATA_URI,
        item: { name: 'Fakeful', href: 'https://civitai.red/models/1', external: true },
      }}
    />,
    { viewer: { id: 1, username: 'ann' }, flags: {} }
  );
  await expect.element(page.getByTestId('post-published-with-app')).toBeInTheDocument();
  await expect
    .element(page.getByRole('link', { name: 'Fakeful' }))
    .toHaveAttribute('href', `https://${window.location.host}/models/1`);
});
