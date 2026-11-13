import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import type { Root } from 'react-dom/client';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { ServerDomains } from '~/shared/constants/domain.constants';
import type * as TrpcMod from '~/utils/trpc';
import type * as NextRouterModule from 'next/router';

/**
 * A static shell page is rendered once for every viewer, so its server HTML carries no cookie,
 * session, flag or region. The client's first render must reproduce that HTML exactly whatever the
 * viewer's cookie jar and storage hold — the viewer's values may only arrive after hydration.
 *
 * Real `renderToString` → `hydrateRoot`, as in `ThirdPartyConsentProvider.ssrHydration.browser.test.tsx`:
 * the server HTML is rendered with an EMPTY jar (what the server sees), then the jar is filled and
 * the same tree hydrates over it. The page data never arrives here (`window.__civShell` stays
 * pending), so what is measured is the hydration render alone.
 */

// `_app` always has a router; this is the shell page's once its route query is restored.
vi.mock('next/router', async (importOriginal) => ({
  ...(await importOriginal<typeof NextRouterModule>()),
  useRouter: () => ({
    pathname: '/images/[imageId]',
    asPath: '/images/101',
    query: { imageId: '101' },
  }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcMod>()), trpc: makeTrpcProxy() };
});

const { AppProvider } = await import('~/providers/AppProvider');
const { SessionProvider, useSession } = await import('~/providers/SessionProvider');
const { FeatureFlagsProvider, useFeatureFlagsReady } = await import(
  '~/providers/FeatureFlagsProvider'
);
const { ThirdPartyConsentProvider } = await import(
  '~/components/Consent/ThirdPartyConsentProvider'
);
const { useThirdPartyConsent } = await import('~/components/Consent/consent.context');
const { ShellBootstrapProvider, useShellBootstrap, useShellReady } = await import(
  '~/components/Shell/ShellBootstrapProvider'
);
const { parseCookies } = await import('~/shared/utils/cookies');

const SERVER_DOMAINS: ServerDomains = {
  green: { primary: 'civitai.green', aliases: [] },
  blue: { primary: 'civitai.com', aliases: [] },
  red: { primary: 'civitai.red', aliases: [] },
};

function HydrationBeacon() {
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);
  return <i data-testid="hydrated" data-hydrated={String(hydrated)} />;
}

function Probe({
  consentCookie,
  disableHidden,
}: {
  consentCookie: unknown;
  disableHidden: unknown;
}) {
  const session = useSession();
  const consent = useThirdPartyConsent();
  return (
    <div
      data-testid="probe"
      data-session={session.status}
      data-flags-ready={String(useFeatureFlagsReady())}
      data-shell-ready={String(useShellReady())}
      data-consent-allowed={String(consent.allowed)}
      data-consent-cookie={String(consentCookie)}
      data-disable-hidden={String(disableHidden)}
    />
  );
}

/** `_app`'s shell wiring for the providers the shell boot touches, as a shell render sees it. */
function ShellTree() {
  const [queryClient] = React.useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <ShellApp />
    </QueryClientProvider>
  );
}

function ShellApp() {
  const [bootedShell] = React.useState(true);
  const { cookies, hasAuthCookie, adsGated, sessionSeed, flagsSeed, appShell, status } =
    useShellBootstrap(bootedShell, {
      onShellPage: true,
      cookies: parseCookies({}),
      hasAuthCookie: true,
      adsGated: false,
    });
  return (
    <ShellBootstrapProvider status={status ?? 'pending'}>
      <AppProvider
        seed={1}
        canIndex={false}
        settings={undefined as unknown as UserContentSettings}
        liveNow={false}
        domain="blue"
        host="civitai.com"
        serverDomains={SERVER_DOMAINS}
        availableOAuthProviders={[]}
        verifiedBot={null}
        isAuthed={hasAuthCookie}
        shell={appShell}
      >
        <ThirdPartyConsentProvider initialConsent={cookies.consent} loggedIn={hasAuthCookie}>
          <SessionProvider seed={sessionSeed} refetchOnWindowFocus={false}>
            <FeatureFlagsProvider flags={{} as never} seed={flagsSeed}>
              <Probe consentCookie={cookies.consent} disableHidden={cookies.disableHidden} />
              <i data-testid="ads-gated" data-gated={String(adsGated)} />
              <HydrationBeacon />
            </FeatureFlagsProvider>
          </SessionProvider>
        </ThirdPartyConsentProvider>
      </AppProvider>
    </ShellBootstrapProvider>
  );
}

const HYDRATION_RE =
  /(Hydration failed|An error occurred during hydration|The server HTML was replaced|Expected server HTML|did not match|Text content does not match)/i;

let consoleErrors: string[] = [];
let recoverable: string[] = [];
let restoreConsole: (() => void) | null = null;
const roots: Root[] = [];
const containers: HTMLElement[] = [];

function clearJar() {
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
  localStorage.clear();
}

beforeEach(() => {
  clearJar();
  window.__civShell = new Promise<Response>(() => undefined);
  consoleErrors = [];
  recoverable = [];
  const original = console.error;
  console.error = ((...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    original.apply(console, args as []);
  }) as typeof console.error;
  restoreConsole = () => {
    console.error = original;
  };
});

afterEach(() => {
  restoreConsole?.();
  for (const r of roots.splice(0)) r.unmount();
  for (const c of containers.splice(0)) c.remove();
  delete window.__civShell;
  clearJar();
});

async function hydrateInto(html: string, tree: React.ReactElement, awaitBeacon = true) {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  containers.push(container);
  roots.push(
    hydrateRoot(container, tree, {
      onRecoverableError: (err) => {
        recoverable.push(err instanceof Error ? err.message : String(err));
      },
    })
  );
  if (awaitBeacon) {
    await vi.waitFor(
      () =>
        expect(
          container.querySelector('[data-testid="hydrated"]')?.getAttribute('data-hydrated')
        ).toBe('true'),
      { timeout: 10_000 }
    );
  } else {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return container;
}

const hydrationConsoleErrors = () => consoleErrors.filter((e) => HYDRATION_RE.test(e));

const JARS: [string, string[], Record<string, string>][] = [
  ['an empty jar', [], {}],
  [
    'consent rejected, hidden content shown, a referral',
    ['civitai-consent=rejected', 'disableHidden=false', 'ref_code=abc', 'ref_landing_page=%2Fx'],
    { 'civitai:adengine': 'staging' },
  ],
  [
    'consent accepted, a colour scheme, an apps-rail cookie',
    ['civitai-consent=accepted', 'mantine-color-scheme=light', 'apps-rail=collapsed'],
    { 'browsing-settings': '{"state":{"blurNsfw":false}}' },
  ],
];

describe('a shell boot hydrates the viewer-independent server HTML cleanly', () => {
  test('INSTRUMENT CHECK: a genuine server/client divergence IS reported by both signals', async () => {
    let onServer = true;
    function Diverges() {
      return onServer ? <p>server</p> : <span>client</span>;
    }
    const html = renderToString(<Diverges />);
    onServer = false;
    await hydrateInto(html, <Diverges />, false);

    expect(recoverable.length).toBeGreaterThan(0);
    expect(hydrationConsoleErrors().length).toBeGreaterThan(0);
  });

  test.each(JARS)('with %s', async (_, cookies, storage) => {
    const html = renderToString(<ShellTree />);
    // The pending state is what the server HTML carries.
    expect(html).toContain('data-session="loading"');
    expect(html).toContain('data-flags-ready="false"');
    expect(html).toContain('data-shell-ready="false"');
    expect(html).toContain('data-consent-allowed="false"');
    expect(html).toContain('data-consent-cookie="null"');
    expect(html).toContain('data-gated="true"');
    expect(html).toContain('data-hydrated="false"');

    for (const c of cookies) document.cookie = `${c}; Path=/`;
    for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);

    const container = await hydrateInto(html, <ShellTree />);

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
    expect(consoleErrors).toEqual([]);
    // After hydration the jar has been read: the cookie decision is now visible, the gate is
    // still closed because the page data never arrived.
    const probe = container.querySelector('[data-testid="probe"]');
    const consent = cookies.find((c) => c.startsWith('civitai-consent='))?.split('=')[1] ?? 'null';
    await vi.waitFor(() => expect(probe?.getAttribute('data-consent-cookie')).toBe(consent));
    expect(probe?.getAttribute('data-consent-allowed')).toBe('false');
    expect(probe?.getAttribute('data-shell-ready')).toBe('false');
  });
});
