import { describe, expect, test, vi } from 'vitest';
import type * as AppProviderModule from '~/providers/AppProvider';

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

const { IntentComposeSheet } = await import('./IntentComposeSheet');
const { renderWithProviders } = await import('../../../../test/component-setup');

async function sourceHref(sourceLink: string) {
  const screen = await renderWithProviders(
    <IntentComposeSheet
      media={[]}
      values={{ title: '', description: '', tags: [] }}
      onChange={() => undefined}
      sourceLink={sourceLink}
      primaryLabel="Post"
      onPrimary={() => undefined}
    />
  );
  return screen.container.querySelector(`a[target="_blank"]`)?.getAttribute('href');
}

describe('IntentComposeSheet source link on civitai.red', () => {
  test('opens a source on another of our sites on the site being read', async () => {
    expect(await sourceHref('https://civitai.com/models/1')).toBe('https://civitai.red/models/1');
  });

  test('leaves a third-party source as written', async () => {
    expect(await sourceHref('https://example.org/x')).toBe('https://example.org/x');
  });
});
