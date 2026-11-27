import { afterEach, describe, expect, test } from 'vitest';
import { IntentComposeSheet } from './IntentComposeSheet';
import { installTrpcWire, renderWithTrpcWire } from '../../../../test/trpcWireHarness';

// The harness mounts the real AppProvider on this page's host, with civitai.red as another of ours.
let wire: ReturnType<typeof installTrpcWire> | undefined;
afterEach(() => wire?.restore());

async function sourceHref(sourceLink: string) {
  wire = installTrpcWire({});
  const screen = await renderWithTrpcWire(
    <IntentComposeSheet
      media={[]}
      values={{ title: '', description: '', tags: [] }}
      onChange={() => undefined}
      sourceLink={sourceLink}
      primaryLabel="Post"
      onPrimary={() => undefined}
    />,
    { viewer: { id: 1, username: 'ann' }, flags: {} }
  );
  return screen.container.querySelector(`a[target="_blank"]`)?.getAttribute('href');
}

describe('IntentComposeSheet source link', () => {
  test('opens a source on another of our sites on the site being read', async () => {
    expect(await sourceHref('https://civitai.red/models/1')).toBe(
      `https://${window.location.host}/models/1`
    );
  });

  test('leaves a third-party source as written', async () => {
    expect(await sourceHref('https://example.org/x')).toBe('https://example.org/x');
  });
});
