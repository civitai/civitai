import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RegionInfo } from '~/server/utils/region-blocking';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { ServerDomains } from '~/shared/constants/domain.constants';
// Type-only namespace import (NOT `typeof import('...')`, which
// @typescript-eslint/consistent-type-imports rejects) so the spread below keeps the real
// module's type.
import type * as TrpcMod from '~/utils/trpc';
import type { ConsentDecision } from '~/components/Consent/consent.utils';

/**
 * 🔴 MOVING THE CONSENT GATE'S REGION FROM A PROP TO CONTEXT MUST NOT MOVE ANY BYTE OF THE
 * SERVER RENDER — MEASURED, NOT REASONED.
 *
 * `ThirdPartyConsentProvider` carries a standing warning that a previous change to HOW it
 * loads (`next/dynamic` instead of a static import) produced a whole-tree hydration mismatch
 * that re-mounted the app and orphaned the server-rendered DOM — the "double layout" bug. The
 * region-source fix is a different kind of change, but it lands on the same component, so the
 * claim it rests on gets exercised here rather than asserted:
 *
 *   On the SSR render and on the FIRST client (hydration) render, `_app` still has the real
 *   SSR `region` — the prop is only absent on SUBSEQUENT client-side navigations. `AppProvider`
 *   seeds its frozen context from that same value at mount, on both sides. So the gate reaches
 *   the same verdict either way and the two renders are identical; only a later navigation
 *   diverges, and that divergence is the whole point of the fix.
 *
 * DETECTOR = `hydrateRoot`'s `onRecoverableError`, which is what React calls on a hydration
 * mismatch. A `console.error` text match is a SECOND, independent signal, so a change to
 * React's warning text cannot silently disarm both. The INSTRUMENT CHECK below is the control
 * for the detector itself: without it, "no mismatch" is indistinguishable from a spy attached
 * to nothing. Pattern borrowed from
 * `src/components/Apps/AppsRailNav.ssrHydration.browser.test.tsx`.
 *
 * The client-navigation BEHAVIOUR — the actual fix — is pinned by
 * `src/components/Consent/ThirdPartyConsentProvider.browser.test.tsx`. This file pins only
 * that the fix costs nothing at hydration.
 */

// Only the ambient queries `AppProvider` fires. Spread of the real module, not a wholesale
// replacement (`local-rules/no-wholesale-module-mock`).
vi.mock('~/utils/trpc', async (importOriginal) => {
  const seeded = () => ({ data: undefined, isInitialLoading: false });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: {
      user: { getSettings: { useQuery: seeded }, getFollowingUsers: { useQuery: seeded } },
      system: { getLiveNow: { useQuery: seeded } },
      chat: { getUserSettings: { useQuery: seeded } },
    },
  };
});

const { AppProvider } = await import('~/providers/AppProvider');
const { ThirdPartyConsentProvider } = await import(
  '~/components/Consent/ThirdPartyConsentProvider'
);
const { useThirdPartyConsent } = await import('~/components/Consent/consent.context');

/**
 * 🔴 THIS FILE IS AN INVARIANT GUARD, NOT A REGRESSION TEST — it is GREEN at the pre-fix
 * commit as well as after, and deliberately so. Its claim is "the fix costs nothing at
 * hydration", and a test that only goes green after the fix could not make that claim about
 * the fix at all. Threading `region` to the consent provider as well as to `AppProvider` (the
 * pre-fix `_app` wiring) is what keeps it runnable on both sides; post-fix the prop is simply
 * ignored, because React ignores props a component does not read. `React.ComponentProps` keeps
 * the rest of the signature honest, so a real prop change still fails here.
 *
 * Its sibling `ThirdPartyConsentProvider.browser.test.tsx` is the regression test (red at the
 * pre-fix commit, green after). Do not read this file's green as evidence the fix works.
 */
const ConsentProviderWithLegacyRegionProp =
  ThirdPartyConsentProvider as unknown as React.ComponentType<
    React.ComponentProps<typeof ThirdPartyConsentProvider> & { region?: RegionInfo }
  >;

const CALIFORNIA: RegionInfo = { countryCode: 'US', regionCode: 'CA', fullLocationCode: 'US:CA' };
const TEXAS: RegionInfo = { countryCode: 'US', regionCode: 'TX', fullLocationCode: 'US:TX' };

const SERVER_DOMAINS: ServerDomains = {
  green: { primary: 'civitai.green', aliases: [] },
  blue: { primary: 'civitai.com', aliases: [] },
  red: { primary: 'civitai.red', aliases: [] },
};

function Probe() {
  const { consent, required, allowed } = useThirdPartyConsent();
  return (
    <div
      data-testid="consent-probe"
      data-required={String(required)}
      data-allowed={String(allowed)}
      data-consent={consent ?? 'none'}
    />
  );
}

/**
 * The `_app` wiring, reduced to the two providers that matter, under the providers the
 * consent banner needs. `region` here is the SSR value — present on BOTH the server render and
 * the hydration render, which is exactly the premise under test.
 */
function Tree({
  region,
  initialConsent,
}: {
  region: RegionInfo | undefined;
  initialConsent: ConsentDecision | null;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <AppProvider
          seed={1}
          canIndex={false}
          settings={{} as UserContentSettings}
          liveNow={false}
          region={region}
          domain="blue"
          host="civitai.com"
          serverDomains={SERVER_DOMAINS}
          availableOAuthProviders={[]}
          verifiedBot={null}
          isAuthed={false}
        >
          <ConsentProviderWithLegacyRegionProp
            region={region}
            initialConsent={initialConsent}
            loggedIn={false}
          >
            <Probe />
          </ConsentProviderWithLegacyRegionProp>
        </AppProvider>
      </MantineProvider>
    </QueryClientProvider>
  );
}

/**
 * React's hydration-mismatch vocabulary (React 18). Deliberately NARROW — a broad `/hydrat/`
 * matches MantineProvider's benign "useLayoutEffect does nothing on the server … non-hydrated
 * UI" SSR notice, which fires on every server render of any Mantine tree.
 */
const HYDRATION_RE =
  /(Hydration failed|An error occurred during hydration|The server HTML was replaced|Expected server HTML|did not match|Text content does not match)/i;

let consoleErrors: string[] = [];
let recoverable: string[] = [];
let restoreConsole: (() => void) | null = null;
const containers: HTMLElement[] = [];

beforeEach(() => {
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
  restoreConsole = null;
  for (const c of containers.splice(0)) c.remove();
});

/** console.error lines that name a hydration problem (the SECOND signal). */
function hydrationConsoleErrors() {
  return consoleErrors.filter(
    (e) => HYDRATION_RE.test(e) && !/useLayoutEffect does nothing on the server/.test(e)
  );
}

/**
 * Plant `html` in a fresh container and hydrate it with `tree`, capturing every recoverable
 * error React reports. No `act()` — React 18.3's lives in `react-dom/test-utils`, which this
 * repo's `@types/react-dom` cannot resolve through its `exports` map. Yielding macrotasks is
 * only sound because the INSTRUMENT CHECK would report ZERO recoverable errors if the
 * hydration had not run at all, so "no mismatch" cannot come from "nothing happened".
 */
async function hydrateInto(html: string, tree: React.ReactElement) {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  containers.push(container);
  hydrateRoot(container, tree, {
    onRecoverableError: (err) => {
      recoverable.push(err instanceof Error ? err.message : String(err));
    },
  });
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return container;
}

const probeAttrs = (container: HTMLElement) => {
  const el = container.querySelector('[data-testid="consent-probe"]');
  return {
    required: el?.getAttribute('data-required') ?? null,
    allowed: el?.getAttribute('data-allowed') ?? null,
    consent: el?.getAttribute('data-consent') ?? null,
  };
};

describe('ThirdPartyConsentProvider — real SSR → hydrate', () => {
  test('🔴 INSTRUMENT CHECK: a genuine server/client divergence IS reported by BOTH signals', async () => {
    let onServer = true;
    function Diverges() {
      return onServer ? <p>server</p> : <span>client</span>;
    }
    const html = renderToString(<Diverges />);
    onServer = false;
    await hydrateInto(html, <Diverges />);

    expect(recoverable.length).toBeGreaterThan(0);
    expect(recoverable.join('\n')).toMatch(HYDRATION_RE);
    expect(hydrationConsoleErrors().length).toBeGreaterThan(0);
  });

  test('CA + rejected: the gate is applied in the SERVER HTML and hydration is clean', async () => {
    const html = renderToString(<Tree region={CALIFORNIA} initialConsent="rejected" />);

    // The decision is already correct on the first server render — the context read has not
    // deferred it to an effect. This is the half a "no hydration warning" assertion cannot
    // see: a tree that renders nothing on both sides also hydrates cleanly.
    expect(html).toContain('data-allowed="false"');
    expect(html).toContain('data-required="true"');
    // The banner must NOT be in the server HTML for an already-decided visitor.
    expect(html).not.toContain('Your privacy choices');

    const container = await hydrateInto(
      html,
      <Tree region={CALIFORNIA} initialConsent="rejected" />
    );

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
    expect(probeAttrs(container)).toEqual({
      required: 'true',
      allowed: 'false',
      consent: 'rejected',
    });
  });

  test('CA + undecided: the banner is SERVER-rendered and hydration is clean', async () => {
    const html = renderToString(<Tree region={CALIFORNIA} initialConsent={null} />);

    expect(html).toContain('Your privacy choices');
    expect(html).toContain('data-allowed="false"');

    const container = await hydrateInto(html, <Tree region={CALIFORNIA} initialConsent={null} />);

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
    expect(container.textContent).toContain('Your privacy choices');
  });

  test('a non-consent region renders NO gate and NO banner, and hydrates clean', async () => {
    const html = renderToString(<Tree region={TEXAS} initialConsent={null} />);

    // The reachability arm: `data-allowed="true"` has to be producible through this harness,
    // or the two assertions above could be green because the probe can only say 'false'.
    expect(html).toContain('data-allowed="true"');
    expect(html).toContain('data-required="false"');
    expect(html).not.toContain('Your privacy choices');

    const container = await hydrateInto(html, <Tree region={TEXAS} initialConsent={null} />);

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
    expect(probeAttrs(container)).toEqual({
      required: 'false',
      allowed: 'true',
      consent: 'none',
    });
  });
});
