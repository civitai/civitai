/**
 * The creator card's name row at a narrow card width, with the action buttons that creators with a
 * shop, tips and chat get.
 *
 * The name side used to be the only part of the row that shrank, so a card too narrow for the
 * actions left the name a few pixels ("V", "Jo"). The actions now wrap under the name when they do
 * not fit, and stay beside it when they do.
 *
 * `geometry` project: the wrapping comes from real flex layout, which the `component` tier (no
 * stylesheet) does not have. The actions are plain fixed-size boxes so the test does not depend on
 * Mantine button sizes, which differ with zoom and account settings.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
import type * as BrowserSettings from '~/providers/BrowserSettingsProvider';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as Trpc from '~/utils/trpc';
import { box, renderAtViewport } from '../../../test/geometry-setup';

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof Trpc>()), trpc: makeTrpcProxy({}) };
});

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => ({}),
}));

vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettings>()),
  useBrowsingSettings: (selector: (s: object) => unknown) => selector({}),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

const { IntersectionObserverProvider } = await import(
  '~/components/IntersectionObserver/IntersectionObserverProvider'
);
const { CreatorCardSimple } = await import('~/components/CreatorCard/CreatorCardSimple');

const CARD_WIDTH = 320;
const NAME = 'AVeryLongCreatorNameThatFillsAnyRoom';
/** Below this the name reads as "V" / "Jo". */
const MIN_NAME_WIDTH = 100;

async function renderCard(buttonWidths: number[]) {
  await renderAtViewport(
    <IntersectionObserverProvider>
      <div style={{ width: CARD_WIDTH }}>
        <CreatorCardSimple
          user={{ id: 7, username: NAME }}
          actions={() => (
            <div data-testid="actions" style={{ display: 'flex', gap: 8, flexWrap: 'nowrap' }}>
              {buttonWidths.map((w, i) => (
                <button key={i} type="button" style={{ width: w, height: 32, flexShrink: 0 }} />
              ))}
            </div>
          )}
        />
      </div>
    </IntersectionObserverProvider>,
    { width: 390, height: 844 }
  );
  await vi.waitFor(() => expect(page.getByTestId('actions').element()).toBeTruthy());
  const name = page.getByText(NAME).element();
  const actions = page.getByTestId('actions').element();
  return { name: box(name), actions: box(actions) };
}

afterEach(() => cleanup());

describe('CreatorCardSimple name row at a 320px card', () => {
  test.each([
    ['shop, tip, chat and a 100px Unfollow at 32px', [32, 32, 32, 100]],
    ['the same four at 48px', [48, 48, 48, 100]],
  ])('keeps the name readable with %s', async (_label, widths) => {
    const { name, actions } = await renderCard(widths);
    expect(name.width).toBeGreaterThanOrEqual(MIN_NAME_WIDTH);
    // Wrapped actions sit below the name, in a row of their own.
    expect(actions.top).toBeGreaterThanOrEqual(name.bottom);
  });

  test('keeps two icon actions on the same row as the name', async () => {
    const { name, actions } = await renderCard([32, 32]);
    expect(name.width).toBeGreaterThanOrEqual(MIN_NAME_WIDTH);
    expect(actions.top).toBeLessThan(name.bottom);
  });
});
