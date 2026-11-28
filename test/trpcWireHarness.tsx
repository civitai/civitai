import React from 'react';
import superjson from 'superjson';
import { vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MantineProvider } from '@mantine/core';
import { CivitaiSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import { AppProvider } from '~/providers/AppProvider';
import { BrowserSettingsProvider } from '~/providers/BrowserSettingsProvider';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import { SessionProvider } from '~/providers/SessionProvider';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { Session } from '~/types/session';
import { queryClient, trpc } from '~/utils/trpc';

export type WireCall = { path: string; type: 'query' | 'mutation'; input: unknown };
type Respond = (input: unknown) => unknown;

/**
 * Mounts a component under the app's real tRPC client (`trpc.withTRPC`, the app's own links and
 * transformer) and its real App, Session, FeatureFlags, CivitaiSession, BrowserSettings and Dialog
 * providers. The fakes are the network (`window.fetch` answers `/api/trpc/*` in tRPC's wire format)
 * and `next/router`, which the component project's setup file mocks for every test.
 *
 * Use it when the claim is what a user's click sends to the server. `makeTrpcProxy` and
 * `makeQueryClientTrpcFake` replace `~/utils/trpc` itself, so a component's own mutation wiring
 * never runs under them.
 *
 * Every request is recorded in `calls` (procedure path, type and the decoded input). A procedure
 * with no scripted answer fails with a tRPC 500 and is listed in `unscripted`, so a provider's
 * background query cannot pass for an answered one. Batching stays off (its flag is never set
 * here), so each operation is its own request.
 */

export function installTrpcWire(responses: Record<string, Respond>) {
  const calls: WireCall[] = [];
  const unscripted: string[] = [];

  const answer = async (path: string, type: WireCall['type'], input: unknown) => {
    calls.push({ path, type, input });
    const respond = responses[path];
    if (!respond) {
      unscripted.push(path);
      return wireError(path, 'unscripted procedure');
    }
    return Response.json({ result: { data: superjson.serialize(await respond(input)) } });
  };

  const original = window.fetch;
  const spy = vi.spyOn(window, 'fetch').mockImplementation(async (resource, init) => {
    const url = new URL(
      resource instanceof Request ? resource.url : String(resource),
      window.location.href
    );
    if (!url.pathname.startsWith('/api/trpc/')) return original(resource, init);
    if (url.searchParams.has('batch')) throw new Error(`trpc wire: batched request ${url.href}`);

    const path = decodeURIComponent(url.pathname.slice('/api/trpc/'.length));
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = method === 'GET' ? url.searchParams.get('input') : (init?.body as string | null);
    const input = raw ? superjson.deserialize(JSON.parse(raw)) : undefined;
    // The wire does not say which a POST is: a query too large for a URL is sent as POST too
    // (`isLargeQuery`), and is recorded here as a mutation.
    const type = method === 'GET' ? 'query' : 'mutation';
    return answer(path, type, input);
  });

  return {
    calls,
    unscripted,
    /** The calls to one procedure, in order. */
    callsTo: (path: string) => calls.filter((call) => call.path === path),
    restore: () => {
      spy.mockRestore();
      queryClient.clear();
      useDialogStore.getState().closeAll();
    },
  };
}

function wireError(path: string, message: string) {
  const shape = {
    message,
    code: -32603,
    data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path },
  };
  return Response.json({ error: superjson.serialize(shape) }, { status: 500 });
}

export type WireViewer = { id: number; username: string };

/** The provider stack `_app` mounts, cut to what a signed-in page needs. */
export function renderWithTrpcWire(
  ui: React.ReactElement,
  {
    viewer,
    flags,
    appFrameDomains,
  }: {
    viewer: WireViewer;
    flags: Partial<FeatureAccess>;
    /** `_app`'s App Block frame roots; omitted, the provider carries none (as a tab with no server props). */
    appFrameDomains?: { appsDomain: string | null; previewDomain: string | null };
  }
) {
  const session: Session = {
    user: { ...viewer, showNsfw: false, blurNsfw: true, browsingLevel: 1, onboarding: 15 },
  };
  const features = flags as FeatureAccess;

  const Root = trpc.withTRPC(function Root() {
    return (
      <AppProvider
        settings={{} as UserContentSettings}
        seed={1}
        canIndex={false}
        liveNow={false}
        domain="blue"
        host={window.location.host}
        serverDomains={{
          green: { primary: 'civitai.green', aliases: [] },
          blue: { primary: window.location.host, aliases: [] },
          red: { primary: 'civitai.red', aliases: [] },
        }}
        appFrameDomains={appFrameDomains}
        availableOAuthProviders={[]}
        verifiedBot={null}
        isAuthed
      >
        <SessionProvider session={session} refetchOnWindowFocus={false}>
          <FeatureFlagsProvider flags={features} userFlags={features}>
            <CivitaiSessionProvider>
              <BrowserSettingsProvider>
                <MantineProvider>
                  {ui}
                  <DialogProvider />
                </MantineProvider>
              </BrowserSettingsProvider>
            </CivitaiSessionProvider>
          </FeatureFlagsProvider>
        </SessionProvider>
      </AppProvider>
    );
  });

  return render(<Root />);
}
