// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';

type ReplaceTarget = { pathname: string; query: Record<string, string>; hash: string };

const MAX_REPLACES = 5;
const replace = vi.fn((target: ReplaceTarget) => {
  if (replace.mock.calls.length > MAX_REPLACES) {
    throw new Error(`redirect loop: ${replace.mock.calls.length} replaces`);
  }
  const search = new URLSearchParams(target.query).toString();
  window.history.replaceState(
    null,
    '',
    `${target.pathname}${search ? `?${search}` : ''}#${target.hash}`
  );
  // Worst case for a loop: the replaced URL is observed as a fresh hash navigation.
  window.dispatchEvent(new HashChangeEvent('hashchange'));
});
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, replace }) }));

const { useLegacyAnchorRedirect } = await import('~/components/Account/useLegacyAnchorRedirect');

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useLegacyAnchorRedirect();
  return null;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(React.createElement(Probe)));
}

function unmount() {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}

afterEach(() => {
  unmount();
  replace.mockClear();
});

describe('useLegacyAnchorRedirect', () => {
  it('redirects a legacy anchor to its pane once, keeping the fragment', () => {
    window.history.replaceState(null, '', '/user/account?ref=challenge#creator-score');

    mount();

    expect(replace).toHaveBeenCalledTimes(1);
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      '/user/account/profile?ref=challenge#creator-score'
    );
  });

  it('does not replace again when the pane remounts on the redirected URL', () => {
    window.history.replaceState(null, '', '/user/account#creator-score');
    mount();
    unmount();

    mount();

    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('follows an in-page hash change once, even though the redirect fires hashchange itself', () => {
    window.history.replaceState(null, '', '/user/account/billing');
    mount();
    expect(replace).not.toHaveBeenCalled();

    act(() => {
      window.history.replaceState(null, '', '/user/account#creator-score');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(replace).toHaveBeenCalledTimes(1);
    expect(`${window.location.pathname}${window.location.hash}`).toBe(
      '/user/account/profile#creator-score'
    );
  });
});
