import * as React from 'react';
import { flushSync } from 'react-dom';
import { renderToString } from 'react-dom/server';
import type { Root } from 'react-dom/client';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ClientOnlySection,
  ClientOnlySectionsProvider,
} from '~/components/ClientOnlySection/ClientOnlySection';
import { IsClientProvider } from '~/providers/IsClientProvider';

/**
 * `ClientOnlySection` across the server → client seam: a real `renderToString` → `hydrateRoot`, as
 * in `ImageDetailPage.ssrHydration.browser.test.tsx`. Both with `_app`'s `IsClientProvider` above
 * it and without one (the hook's own hydration-safe fallback).
 */

const HYDRATION_RE =
  /(Hydration failed|An error occurred during hydration|The server HTML was replaced|Expected server HTML|did not match|Text content does not match)/i;

let consoleErrors: string[] = [];
let recoverable: string[] = [];
let restoreConsole: (() => void) | null = null;
const roots: Root[] = [];
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
  for (const r of roots.splice(0)) r.unmount();
  for (const c of containers.splice(0)) c.remove();
});

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const hydrationErrors = () => [
  ...recoverable,
  ...consoleErrors.filter((e) => HYDRATION_RE.test(e)),
];

async function serverThenHydrate(tree: () => React.ReactElement) {
  const html = renderToString(tree());
  consoleErrors = [];
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  containers.push(container);
  roots.push(
    hydrateRoot(container, tree(), {
      onRecoverableError: (err) =>
        recoverable.push(err instanceof Error ? err.message : String(err)),
    })
  );
  await flush();
  return { html, container };
}

function Page({
  enabled,
  withIsClientProvider,
}: {
  enabled?: boolean;
  withIsClientProvider: boolean;
}) {
  const body = (
    <ClientOnlySectionsProvider enabled={enabled}>
      <h1 data-testid="above">Title</h1>
      <ClientOnlySection name="comments" minHeight={321}>
        <section data-testid="deferred">Comments</section>
      </ClientOnlySection>
    </ClientOnlySectionsProvider>
  );
  return withIsClientProvider ? <IsClientProvider>{body}</IsClientProvider> : body;
}

describe('ClientOnlySection', () => {
  test('INSTRUMENT CHECK: a genuine server/client divergence IS reported', async () => {
    let onServer = true;
    function Diverges() {
      return onServer ? <p>server</p> : <span>client</span>;
    }
    const html = renderToString(<Diverges />);
    onServer = false;
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    containers.push(container);
    roots.push(
      hydrateRoot(container, <Diverges />, {
        onRecoverableError: (err) =>
          recoverable.push(err instanceof Error ? err.message : String(err)),
      })
    );
    await flush();
    expect(hydrationErrors().length).toBeGreaterThan(0);
  });

  describe.each([true, false])('with IsClientProvider: %s', (withIsClientProvider) => {
    test.each([false, undefined])(
      'switch off (%s): the server renders the section, and hydrates over it',
      async (enabled) => {
        const { html, container } = await serverThenHydrate(() => (
          <Page enabled={enabled} withIsClientProvider={withIsClientProvider} />
        ));
        expect(html).toContain('data-testid="deferred"');
        expect(html).not.toContain('data-client-only-section');
        expect(hydrationErrors()).toEqual([]);
        expect(container.querySelector('[data-testid="deferred"]')).not.toBeNull();
      }
    );

    test('no provider at all: the server renders the section', () => {
      const html = renderToString(
        <ClientOnlySection name="comments">
          <section data-testid="deferred" />
        </ClientOnlySection>
      );
      expect(html).toContain('data-testid="deferred"');
    });

    test('switch on: the server renders the placeholder, and the section mounts after hydration', async () => {
      const { html, container } = await serverThenHydrate(() => (
        <Page enabled withIsClientProvider={withIsClientProvider} />
      ));
      // What the server sends: everything else, and a placeholder holding the section's height.
      expect(html).toContain('data-testid="above"');
      expect(html).not.toContain('data-testid="deferred"');
      expect(html).toContain('data-client-only-section="comments"');
      expect(html).toContain('min-height:321px');
      // The hydrating render agreed with it, then the section replaced the placeholder.
      expect(hydrationErrors()).toEqual([]);
      expect(container.querySelector('[data-testid="deferred"]')).not.toBeNull();
      expect(container.querySelector('[data-client-only-section]')).toBeNull();
    });
  });

  test('switch on, mounted on the client (a navigation or a modal): the section renders at once', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    function Mounted() {
      return (
        <ClientOnlySectionsProvider enabled>
          <ClientOnlySection name="comments">
            <section data-testid="deferred" />
          </ClientOnlySection>
        </ClientOnlySectionsProvider>
      );
    }
    // `flushSync`: the FIRST commit is what is read, so a placeholder-then-section mount fails here.
    flushSync(() => root.render(<Mounted />));
    expect(container.querySelector('[data-testid="deferred"]')).not.toBeNull();
    expect(container.querySelector('[data-client-only-section]')).toBeNull();
  });
});
