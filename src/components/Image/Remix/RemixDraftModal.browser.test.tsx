import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { installTrpcWire, renderWithTrpcWire } from '../../../../test/trpcWireHarness';
import { RemixDraftModalContent } from '~/components/Image/Remix/RemixAppModal';
import { DEFAULT_ENGINE } from '~/shared/constants/remix-apps.constants';
import type { RemixDeclarativeSpec } from '~/shared/remix-apps/row.schema';

const spec: RemixDeclarativeSpec = {
  icon: 'sparkles',
  engine: DEFAULT_ENGINE,
  asks: [
    { id: 'outfit', kind: 'text', prompt: 'What should they wear?', maxLength: 80 },
    { id: 'look', kind: 'image', prompt: 'Pick a reference', optional: true },
    {
      id: 'mood',
      kind: 'choice',
      prompt: 'Pick a mood',
      options: [
        { value: 'calm', label: 'Calm', fragments: { tone: 'soft light' } },
        { value: 'bold', label: 'Bold', fragments: { tone: 'hard light' } },
      ],
    },
  ],
  steps: [
    {
      kind: 'image',
      prompt: 'Dress them in {{outfit}}, {{tone}}.',
      aspectRatio: 'source',
      quantity: 2,
      input: 'source',
      references: ['look'],
    },
  ],
};
const source = { imageId: 5, url: 'https://example.com/source.png', width: 832, height: 1216 };

// The real tRPC client; only the network is fake, and it records every request.
/** `AppProvider` asks for this on mount, whatever it renders. */
const APP_PROVIDER_QUERY = 'event.getNavBanners';
let wire: ReturnType<typeof installTrpcWire>;
beforeEach(() => {
  wire = installTrpcWire({ [APP_PROVIDER_QUERY]: () => [] });
});
afterEach(() => wire.restore());

test('a draft walks its asks to placeholder results without calling the server', async () => {
  const onClose = vi.fn();
  renderWithTrpcWire(
    <RemixDraftModalContent
      listing={{ slug: 'dress-up', name: 'Dress up', version: 1 }}
      spec={spec}
      source={source}
      onClose={onClose}
    />,
    { viewer: { id: 9, username: 'ann' }, flags: { remixApps: true } }
  );

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('textbox', { name: 'What should they wear?' }).fill('a denim jacket');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Use this image for the preview' }).click();
  await page.getByRole('button', { name: 'Bold' }).click();

  // The step's two images, at the source's shape.
  const outputs = page.getByTestId('remix-preview-output');
  await expect.poll(() => outputs.elements().length).toBe(2);
  expect(outputs.first().element().getAttribute('style')).toContain('832 / 1216');
  await expect.element(page.getByRole('button', { name: 'Preview again' })).toBeVisible();
  // Nothing to post, queue or dismiss.
  expect(page.getByTestId('remix-result-line').elements()).toHaveLength(0);
  expect(wire.calls.map((call) => call.path).filter((path) => path !== APP_PROVIDER_QUERY)).toEqual(
    []
  );
});
