/**
 * Component-test scaffold (Vitest browser mode).
 *
 * Loaded as the `component` project's setupFile (vitest.config.mts) AND imported
 * by `*.browser.test.tsx` files for `renderWithProviders`. Side effects on load:
 *  - mock `next/router` (pages-router components call `useRouter()` at render)
 *  - auto-`cleanup()` the rendered tree after every test
 *
 * `renderWithProviders` wraps the unit-under-test in the providers a generation
 * leaf needs: a fresh React-Query client (`retry: false`) + MantineProvider.
 * tRPC hooks are mocked per-test with `vi.mock('~/utils/trpc')` as we climb to
 * data-driven inputs — this scaffold stays network-free.
 */
import React from 'react';
import { afterEach, vi } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// Raw text, NOT a stylesheet import — see the block below for why that distinction
// is the whole point.
import globalsCss from '~/styles/globals.css?raw';

/**
 * 🔴 THE APP'S ROOT CUSTOM PROPERTIES, AND ONLY THOSE.
 *
 * This harness loads no app stylesheet, so every `var(--header-height)` in a
 * component under test resolved to `""`. That is not "a missing nicety": an
 * unresolvable `var()` makes the whole declaration **invalid at computed-value
 * time**, so `min-height: calc(100dvh - var(--header-height))` silently becomes
 * `auto`/`0px` and the component lays out differently here than in production —
 * measured in real Chromium. **33 TS/TSX files and 7 stylesheets read
 * `--header-height` today**, so that divergence was repo-wide and invisible: a
 * layout assertion could be green against geometry no user ever sees.
 *
 * 🔴 Why the properties are EXTRACTED rather than the stylesheet IMPORTED.
 * Importing `~/styles/globals.css` pulls the real cascade — Tailwind preflight,
 * `@layer` ordering, element defaults — which changes the rendered geometry of
 * every existing test (Mantine `Group` starts centring its items, so same-line
 * assertions written against `top` begin failing against correct code). That is a
 * much larger change than this fixes. Taking only the `:root` custom properties
 * gives components the values they read while leaving the cascade exactly as the
 * suite has always had it.
 *
 * 🔴 Why they are PARSED rather than restated. Hardcoding `--header-height: 60px`
 * here would be a fourth copy of a constant that civitai#4379 existed to
 * consolidate, and it would drift silently the first time the header is resized.
 * The values come from `globals.css` itself, so there is nothing to keep in step.
 */
{
  // 🔴 EXACTLY ONE `:root` — refuse to guess, rather than silently grading the
  // wrong block. The extraction takes the first match, so a SECOND `:root`
  // anywhere earlier in the file (inside an `@media`, say) would be injected
  // UNCONDITIONALLY and would drop every property the real block declares. That
  // failure is invisible from the outside: components would lay out against a
  // header height no user ever sees, with the whole suite green. There is no
  // cheap way to know which block was meant, so this stops and says so.
  const rootBlocks = globalsCss.match(/:root\s*\{/g) ?? [];
  if (rootBlocks.length !== 1) {
    throw new Error(
      `component-setup: expected exactly ONE \`:root {\` block in src/styles/globals.css, ` +
        `found ${rootBlocks.length}. The extraction below takes the FIRST match, so more than ` +
        'one means it may inject a conditional block unconditionally and drop the real ' +
        'properties. Decide deliberately which block the component harness should use.'
    );
  }
  const rootBlock = /:root\s*\{([^}]*)\}/.exec(globalsCss)?.[1];
  if (!rootBlock) {
    // Loud, not silent: if this stops matching, every component test goes back to
    // laying out against undefined custom properties, and nothing else would say so.
    throw new Error(
      'component-setup: no `:root { … }` block found in src/styles/globals.css — the ' +
        'custom-property injection below is inert. Fix the extraction rather than deleting it.'
    );
  }
  // 🔴 Strip CSS comments BEFORE splitting. `split(';')` leaves a commented line
  // glued to the declaration that follows it (`/* … */\n  --footer-height: 45px`),
  // which then fails `startsWith('--')` and is dropped — silently, because the
  // other properties still survive so no count reaches zero. Measured: documenting
  // a variable in `globals.css` dropped `--footer-height` with all 190 files green,
  // and it is read inside `calc()` by the auctions page and CollectionsLayout.
  // Commenting a variable is the most ordinary edit imaginable; it must not
  // silently reintroduce the divergence this whole block exists to remove.
  const declarations = rootBlock.replace(/\/\*[\s\S]*?\*\//g, '');
  const customProps = declarations
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.startsWith('--'));
  // The parse must account for every property the block declares. A count that
  // drops is the partial-parse case above; only zero was checked before, and zero
  // is the one shape that cannot happen while any property survives.
  const declared = declarations.match(/(?:^|[;{])\s*--[\w-]+\s*:/g) ?? [];
  if (customProps.length !== declared.length) {
    throw new Error(
      `component-setup: parsed ${customProps.length} custom propert(ies) from the \`:root\` ` +
        `block in globals.css but it declares ${declared.length}. Something in that block is ` +
        'not being parsed — the missing ones would be UNDEFINED in every component test, which ' +
        'is exactly the divergence this injection removes.'
    );
  }
  if (customProps.length === 0) {
    throw new Error(
      'component-setup: the `:root` block in globals.css declares no custom properties. ' +
        'Either it moved, or the extraction regex is matching the wrong block.'
    );
  }
  const style = document.createElement('style');
  style.setAttribute('data-source', 'component-setup:globals.css :root');
  style.textContent = `:root { ${customProps.join('; ')}; }`;
  document.head.appendChild(style);
}

// `vi.waitFor` defaults to a 1000ms timeout. That's fine for a DOM mount, but
// the browser suite has ~80 waitFor sites and many await an async round-trip
// (postMessage → consent dialog, a tRPC query settling, a zustand store update).
// On the saturated preview CI box (browser tests share the host with the image
// build) a genuinely-correct round-trip can exceed 1000ms, so the waitFor times
// out and the test PASS→FAILs on load, not on code. Raise the DEFAULT timeout
// globally (calls that pass their own timeout are untouched) — one root-cause fix
// for the whole 1000ms-vs-contention class instead of editing every call site.
{
  const DEFAULT_WAITFOR_TIMEOUT_MS = 10000;
  const original = vi.waitFor.bind(vi);
  vi.waitFor = ((callback: Parameters<typeof original>[0], options?: number | object) => {
    const opts = typeof options === 'number' ? { timeout: options } : { ...(options ?? {}) };
    if ((opts as { timeout?: number }).timeout == null) {
      (opts as { timeout?: number }).timeout = DEFAULT_WAITFOR_TIMEOUT_MS;
    }
    return original(callback, opts);
  }) as typeof vi.waitFor;
}

// Stub the Next pages-router. Returns vi.fn()s so tests can assert navigation
// without a real router; extend per-test via `vi.mocked(useRouter)` if needed.
vi.mock('next/router', () => {
  const router = {
    push: vi.fn().mockResolvedValue(true),
    replace: vi.fn().mockResolvedValue(true),
    prefetch: vi.fn().mockResolvedValue(undefined),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    beforePopState: vi.fn(),
    query: {},
    pathname: '/',
    asPath: '/',
    route: '/',
    basePath: '',
    isReady: true,
    isFallback: false,
    isPreview: false,
    events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  };
  return {
    // Real `next/router` is an ES module; flag the mock so a DEFAULT import
    // (`import Router from 'next/router'`, used by `useCatchNavigation` and many
    // other components) resolves to the singleton rather than the namespace
    // object under esModuleInterop (whose `.events` would be undefined).
    __esModule: true,
    useRouter: () => router,
    Router: router,
    default: router,
    withRouter: (Component: React.ComponentType) => Component,
  };
});

// Mantine's `useClipboard` (and any copy affordance) calls
// `navigator.clipboard.writeText`. In CI's headless Chromium the page is an
// insecure context with no clipboard permission, so the REAL `writeText`
// rejects — `copied` never flips and the "Copied" affordance never renders.
// That made copy tests pass locally (Chromium grants the permission) but fail
// in CI. Stub a resolving clipboard so copy behaviour is deterministic and
// matches a real secure-context browser. Tests assert the "Copied" UI state,
// not the OS clipboard contents.
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(''),
  },
});

// 🔴 `cleanup()` is ASYNC and the hook MUST await it. Returning the promise (or
// awaiting it) is the whole fix — do not "simplify" this back to a bare
// `cleanup();` statement inside a block body.
//
// vitest-browser-react 2.2.0 `cleanup()` (dist/pure-*.js:112) is
// `async function cleanup()`. Per mounted root it does
// `await act(async () => root.unmount())` and only THEN
// `document.body.removeChild(container)`. So the container removal happens after
// an await, in a later microtask.
//
// The previous form was `afterEach(() => { cleanup(); })` — a block body with no
// return, so the promise floated and Vitest received `undefined` and did not
// wait. Container removal then raced the NEXT test's render, leaving two mounted
// containers in `document.body` at once. Any `page.getByTestId(...)` query is
// document-scoped, so a testid that legitimately appears once per render resolved
// to 2 elements and failed with a strict-mode violation.
//
// That is exactly the shape of the long-running `AppListingDetailBody > the
// "Browse all apps" link is present even when the rail is empty` flake
// (`apps-browse-all` is rendered in exactly ONE place,
// `src/components/Apps/RelatedListings.tsx:105`): load-dependent, red on a busy
// CI box and green on a quiet one, and it moved between container indices.
afterEach(async () => {
  await cleanup();
});

/**
 * A 1x1 transparent PNG — the canonical image fixture for browser tests.
 *
 * 🔴 Use this ANY time a browser test needs an image source it will then assert
 * on. A `data:` URI resolves synchronously and locally, so the `<img>` LOADS and
 * survives for the whole test.
 *
 * An http(s) URL does NOT. Nothing serves it in the test browser, so the fetch
 * fails and the element's real `error` event fires ~11 ms after mount. Whether
 * that BREAKS a test depends on the component, and only the first case below can:
 *   - Mantine `Avatar` (and any bespoke `onError -> placeholder`, e.g.
 *     `src/components/Apps/AppListingCard.tsx:135`) renders a placeholder INSTEAD
 *     of the `<img>` — the element is DESTROYED ~11 ms after mount.
 *   - Mantine `Image` does NOT: it only swaps when `fallbackSrc` is set (and that
 *     prop appears zero times in `src/`), otherwise it re-renders the same `<img>`.
 * So `expect(...querySelector('img')).not.toBeNull()` against an Avatar-backed
 * fixture races that ~11 ms window — passing on a fast local machine and failing
 * on a loaded CI box. That defect sat red on `main` across five PRs before #3551.
 * (An earlier draft of this note said EVERY image-rendering component destroys
 * the `<img>`; that was false — checked against the installed `@mantine/core`.)
 *
 * Deliberately testing the error path (an image that must FAIL to load) is a
 * legitimate exception — see the escape hatch documented on the
 * `local-rules/no-unloadable-image-fixture` ESLint rule.
 */
export const LOADABLE_IMAGE_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function Providers({ children }: { children: React.ReactNode }) {
  // Fresh client per render so cache never leaks between tests.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider>{children}</MantineProvider>
    </QueryClientProvider>
  );
}

/**
 * Render a component under the standard generation-form provider stack.
 *
 * Providers are supplied via the `wrapper` option (not by manually wrapping
 * `ui`) so the `rerender` returned by vitest-browser-react re-applies the SAME
 * wrapper on every re-render. Manually wrapping (`render(<Providers>{ui}</…>)`)
 * works for the initial render but `rerender(newUi)` replaces the root with the
 * bare element — dropping MantineProvider/QueryClient and crashing any Mantine
 * child with "MantineProvider was not found". Passing `wrapper` fixes that for
 * every component test that drives prop changes via `rerender`.
 */
export function renderWithProviders(ui: React.ReactElement) {
  return render(ui, { wrapper: Providers });
}
