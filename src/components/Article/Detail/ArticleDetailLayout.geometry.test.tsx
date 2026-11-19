/**
 * The creator card in the banner layout's sidebar.
 *
 * The sidebar was 20rem, too narrow for the card's avatar, name and the tip, chat and
 * Unfollow actions on one row, so the actions wrapped under the name and the card grew tall and
 * cropped its background. The sidebar is now wide enough for one row.
 *
 * `geometry` project: the wrapping comes from real flex layout and the layout switches on the
 * `@md` container query. The actions are fixed-size boxes so the test does not depend on Mantine
 * button sizes.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
import type * as BrowserSettings from '~/providers/BrowserSettingsProvider';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as Trpc from '~/utils/trpc';
import { box, renderAtViewport } from '../../../../test/geometry-setup';

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
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
const { ArticleDetailLayout } = await import('~/components/Article/Detail/ArticleDetailLayout');

const NAME = 'AVeryLongCreatorNameThatFillsAnyRoom';
/** Below this the name reads as "V" / "Jo". */
const MIN_NAME_WIDTH = 100;

async function renderSidebarCard(viewportWidth: number) {
  await renderAtViewport(
    <IntersectionObserverProvider>
      <div className="@container" style={{ width: viewportWidth }}>
        <ArticleDetailLayout
          banner={<div style={{ height: 40 }} />}
          header={<div />}
          body={<div style={{ height: 200 }} />}
          comments={<div />}
          sidebar={
            <div data-testid="sidebar">
              <CreatorCardSimple
                user={{ id: 7, username: NAME }}
                actions={() => (
                  <div
                    data-testid="actions"
                    style={{ display: 'flex', gap: 8, flexWrap: 'nowrap' }}
                  >
                    {[32, 32, 100].map((w, i) => (
                      <button
                        key={i}
                        type="button"
                        style={{ width: w, height: 32, flexShrink: 0 }}
                      />
                    ))}
                  </div>
                )}
              />
            </div>
          }
        />
      </div>
    </IntersectionObserverProvider>,
    { width: viewportWidth, height: 900 }
  );
  await vi.waitFor(() => expect(page.getByTestId('actions').element()).toBeTruthy());
  return {
    card: box(page.getByTestId('sidebar').element()),
    name: box(page.getByText(NAME).element()),
    actions: box(page.getByTestId('actions').element()),
  };
}

afterEach(() => cleanup());

describe('creator card in the banner layout sidebar', () => {
  test.each([1280, 1440])('keeps the name and actions on one row at %ipx', async (width) => {
    const { name, actions } = await renderSidebarCard(width);
    expect(name.width).toBeGreaterThanOrEqual(MIN_NAME_WIDTH);
    expect(actions.top).toBeLessThan(name.bottom);
  });
});
