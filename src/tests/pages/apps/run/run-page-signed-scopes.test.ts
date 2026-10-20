import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * THE RUN-PAGE SEAM: `/apps/run/[slug]` must hand `useBlockToken`'s
 * `signedScopes` to `PageBlockHost`, which advertises them to the block. The
 * host's own browser tests pass the prop directly, so without this nothing goes
 * red if the page stops forwarding it — and an anonymous viewer's page app is
 * told it holds consent-gated scopes again.
 *
 * Rendered in the NODE unit project (server-render to markup), not browser mode:
 * the page module imports `dbRead` for its `getServerSideProps`, and that import
 * chain only loads with the node env. The hook is stubbed and the host replaced
 * by a prop recorder; the db client is the real one and is never queried.
 *
 * Lives under `src/tests/` because a test file under `src/pages/` is a route to
 * `next build` (see run-page-maturity.test.ts).
 */

const m = vi.hoisted(() => ({
  useBlockToken: vi.fn<(...args: unknown[]) => Record<string, unknown>>(),
  hostProps: null as null | Record<string, unknown>,
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));
vi.mock('@mantine/core', () => ({
  Box: ({ children }: { children?: unknown }) => children ?? null,
  Alert: () => null,
  useComputedColorScheme: () => 'dark',
}));
vi.mock('~/components/AppBlocks/useBlockToken', () => ({ useBlockToken: m.useBlockToken }));
vi.mock('~/components/AppBlocks/PageBlockHost', () => ({
  PageBlockHost: (props: Record<string, unknown>) => {
    m.hostProps = props;
    return null;
  },
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: true }),
}));

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
  it('forwards the mint-signed scopes, not the declared manifest scopes', async () => {
    const { default: RunPage } = await import('~/pages/apps/run/[slug]/[[...path]]');
    renderToStaticMarkup(createElement(RunPage, PROPS));
    expect(m.hostProps).not.toBeNull();
    expect(m.hostProps?.declaredScopes).toEqual(DECLARED);
    expect(m.hostProps?.signedScopes).toEqual(SIGNED);
  });
});
