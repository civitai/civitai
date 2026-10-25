import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOGIN_POPUP_DONE, openLoginPopup } from '~/utils/auth-helpers';

// Regression: every caller passes `pathname + search + hash` as the callback. On a page with a #fragment,
// `location.assign(<same url with that fragment>)` is a same-document fragment navigation — the page never
// reloads, so the viewer stays signed out although the session cookie was set.

let channels: { onmessage: ((e: { data: unknown }) => void) | null; close: () => void }[];
let loc: {
  href: string;
  origin: string;
  assign: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
};
let hist: { state: unknown; replaceState: ReturnType<typeof vi.fn> };

function setup(currentHref: string) {
  const url = new URL(currentHref);
  loc = { href: url.href, origin: url.origin, assign: vi.fn(), reload: vi.fn() };
  hist = { state: null, replaceState: vi.fn() };
  channels = [];
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      close = vi.fn();
      constructor() {
        channels.push(this);
      }
    }
  );
  vi.stubGlobal('window', {
    location: loc,
    history: hist,
    screenX: 0,
    screenY: 0,
    outerWidth: 1280,
    outerHeight: 1024,
    open: vi.fn(() => ({ closed: false, close: vi.fn() })),
  });
}

function completeLogin() {
  expect(channels).toHaveLength(1);
  channels[0].onmessage?.({ data: { type: LOGIN_POPUP_DONE } });
}

describe('openLoginPopup completion', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reloads (not a fragment-only assign) when the callback is this page with a #fragment', () => {
    setup('https://example.test/models/123?tab=a#node-3');
    openLoginPopup('/models/123?tab=a#node-3');
    completeLogin();
    expect(loc.reload).toHaveBeenCalledTimes(1);
    expect(loc.assign).not.toHaveBeenCalled();
    expect(hist.replaceState).not.toHaveBeenCalled();
  });

  it('moves to the callback fragment, then reloads, when only the fragment differs', () => {
    setup('https://example.test/models/123#node-3');
    openLoginPopup('/models/123#comments');
    completeLogin();
    expect(hist.replaceState).toHaveBeenCalledWith(
      null,
      '',
      'https://example.test/models/123#comments'
    );
    expect(loc.reload).toHaveBeenCalledTimes(1);
    expect(hist.replaceState.mock.invocationCallOrder[0]).toBeLessThan(
      loc.reload.mock.invocationCallOrder[0]
    );
    expect(loc.assign).not.toHaveBeenCalled();
  });

  it('drops the fragment, then reloads, when this page has one and the callback does not', () => {
    setup('https://example.test/models/123?tab=a#node-3');
    openLoginPopup('/models/123?tab=a');
    completeLogin();
    expect(hist.replaceState).toHaveBeenCalledWith(
      null,
      '',
      'https://example.test/models/123?tab=a'
    );
    expect(loc.reload).toHaveBeenCalledTimes(1);
    expect(hist.replaceState.mock.invocationCallOrder[0]).toBeLessThan(
      loc.reload.mock.invocationCallOrder[0]
    );
    expect(loc.assign).not.toHaveBeenCalled();
  });

  it('reloads when the callback is this page without a fragment', () => {
    setup('https://example.test/images/7');
    openLoginPopup('/images/7');
    completeLogin();
    expect(loc.reload).toHaveBeenCalledTimes(1);
    expect(loc.assign).not.toHaveBeenCalled();
  });

  it('assigns the callback when it is a different page', () => {
    setup('https://example.test/models/123#node-3');
    openLoginPopup('/user/account?section=a#b');
    completeLogin();
    expect(loc.assign).toHaveBeenCalledWith('/user/account?section=a#b');
    expect(loc.reload).not.toHaveBeenCalled();
  });

  it('assigns the callback when only the query differs', () => {
    setup('https://example.test/models/123?tab=a#node-3');
    openLoginPopup('/models/123?tab=b#node-3');
    completeLogin();
    expect(loc.assign).toHaveBeenCalledWith('/models/123?tab=b#node-3');
    expect(loc.reload).not.toHaveBeenCalled();
  });
});
