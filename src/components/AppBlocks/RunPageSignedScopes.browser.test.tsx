import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ReactElement } from 'react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * THE RUN-PAGE SEAM: `/apps/run/[slug]` must hand `useBlockToken`'s
 * `signedScopes` to `PageBlockHost`, which advertises them to the block. The
 * host's own tests pass the prop directly, so without this nothing goes red if
 * the page stops forwarding it — and an anonymous viewer's page app is told it
 * holds consent-gated scopes again.
 *
 * Same shape as `DevTunnelBlockHost.browser.test.tsx`: the hook is stubbed and
 * the host is replaced by a prop recorder. The server-only modules the page
 * imports for `getServerSideProps` are stubbed so the module loads in a browser.
 */

const m = vi.hoisted(() => ({
  useBlockToken: vi.fn<(...args: unknown[]) => Record<string, unknown>>(),
  hostProps: null as null | Record<string, unknown>,
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));
vi.mock('~/server/db/client', () => ({ dbRead: {} }));
vi.mock('~/server/services/block-registry.service', () => ({ BlockRegistry: {} }));
vi.mock('~/server/services/blocks/app-listing-beta.service', () => ({
  readListingBetaBySlugForRender: vi.fn(),
}));
vi.mock('~/server/services/blocks/app-listing-icon.service', () => ({
  readListingIconBySlugForRender: vi.fn(),
}));
vi.mock('~/server/services/blocks/app-listing-open.service', () => ({
  recordAppListingOpen: vi.fn(),
}));
vi.mock('~/server/services/app-blocks-flag', () => ({ isAppBlocksPrivateRunEnabled: vi.fn() }));
vi.mock('~/server/services/blocks/private-run-access.service', () => ({
  resolvePrivateRunAccess: vi.fn(),
}));
vi.mock('~/server/utils/server-domain', () => ({ ratingAllowedOnHost: () => true }));
vi.mock('~/components/AppBlocks/useBlockToken', () => ({ useBlockToken: m.useBlockToken }));
vi.mock('~/components/AppBlocks/PageBlockHost', () => ({
  PageBlockHost: (props: Record<string, unknown>) => {
    m.hostProps = props;
    return <div data-testid="page-block-host" />;
  },
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: true }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, appBlocksPages: true }),
}));

const { default: RunPage } = await import('~/pages/apps/run/[slug]/[[...path]]');

// Declared, missing and signed are pairwise distinct, so the recorded prop can
// only equal SIGNED if it came from the hook's `signedScopes`.
const DECLARED = ['apps:storage:read', 'apps:storage:publish'];
const SIGNED = ['apps:storage:read'];

const PROPS = {
  appBlockId: 'apb_run',
  blockId: 'my-app',
  appId: 'appblk-my-app',
  appName: 'My App',
  pageTitle: 'My App',
  iframeSrc: 'https://my-app.apps.example/',
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'verified' as const,
  slug: 'my-app',
  scopes: DECLARED,
  isBeta: false,
  betaMessage: null,
  iconUrl: null,
  audience: null,
  privateRunStatus: null,
};

beforeEach(() => {
  m.useBlockToken.mockReset().mockReturnValue({
    token: 't',
    error: null,
    missingScopes: [],
    signedScopes: SIGNED,
  });
  m.hostProps = null;
});

describe('/apps/run/[slug] → PageBlockHost', () => {
  test('forwards the mint-signed scopes, not the declared manifest scopes', async () => {
    // The `Page(...)` wrapper's static props type is not the page's own; render it
    // through the component signature the props actually satisfy.
    const Run = RunPage as unknown as (props: typeof PROPS) => ReactElement;
    renderWithProviders(<Run {...PROPS} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    expect(m.hostProps?.declaredScopes).toEqual(DECLARED);
    expect(m.hostProps?.signedScopes).toEqual(SIGNED);
  });
});
