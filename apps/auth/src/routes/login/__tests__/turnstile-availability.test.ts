import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { probeTurnstile, TURNSTILE_SCRIPT_GRACE_MS } from '../turnstile-availability';

// The login page cannot be rendered here — the app's vitest project is `environment: 'node'` with no
// browser project, so nothing can mount a Svelte component. What IS executable is the decision the page
// delegates to, so the slow-script timeline is played against the real function rather than asserted
// from source text. The seam — that the page routes its absence-shaped evidence through this function —
// is pinned in ./login-captcha.test.ts.

// Mirrors the page's call site. `captchaBlocked` there is
// `turnstileEnforced && captchaUnavailable && !captchaToken` (pinned verbatim in login-captcha.test.ts),
// so on a deployment that enforces, with no token in hand, `captchaUnavailable` IS whether the blocked
// note is on screen and announced.
function mountFallbackSlot(browser: { scriptLoaded: boolean; token: string }) {
  const page = { captchaUnavailable: false, managedWidgetRendered: false };
  const teardown = probeTurnstile({
    scriptPresent: () => browser.scriptLoaded,
    tokenArrived: () => !!browser.token,
    onScriptPresent: () => {
      page.managedWidgetRendered = true;
    },
    onScriptAbsent: () => {
      page.captchaUnavailable = true;
    },
  });
  return { page, teardown };
}

describe('turnstile availability probe', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never announces blocked when the script is merely SLOW', () => {
    // t=8s: the invisible widget missed its deadline and api.js has not executed. Identical evidence to
    // a blocked browser, so the page must say nothing yet.
    const browser = { scriptLoaded: false, token: '' };
    const { page } = mountFallbackSlot(browser);
    expect(page.captchaUnavailable, 'concluded from the first look').toBe(false);

    // t=10s: the script lands. Measured on both sides of the grace, because a probe that fires early
    // would be indistinguishable from one that waits when only the far side is checked.
    browser.scriptLoaded = true;
    vi.advanceTimersByTime(TURNSTILE_SCRIPT_GRACE_MS - 1);
    expect(page.captchaUnavailable).toBe(false);
    vi.advanceTimersByTime(1);

    expect(page.captchaUnavailable, 'the blocked note appeared for a slow script').toBe(false);
    expect(page.managedWidgetRendered).toBe(true);
  });

  it('announces blocked when the script never arrives', () => {
    const browser = { scriptLoaded: false, token: '' };
    const { page } = mountFallbackSlot(browser);
    vi.advanceTimersByTime(TURNSTILE_SCRIPT_GRACE_MS - 1);
    expect(page.captchaUnavailable, 'concluded before the grace elapsed').toBe(false);
    vi.advanceTimersByTime(1);

    expect(page.captchaUnavailable, 'a genuinely blocked browser got no note').toBe(true);
    expect(page.managedWidgetRendered).toBe(false);
  });

  it('withdraws the question when a token arrives during the grace', () => {
    // The late invisible token is the other way the slow case resolves: the widget auto-solves before
    // the second look, which falsifies "the check cannot run here" outright.
    const browser = { scriptLoaded: false, token: '' };
    const { page } = mountFallbackSlot(browser);
    browser.token = 'late-invisible-token';
    vi.advanceTimersByTime(TURNSTILE_SCRIPT_GRACE_MS);

    expect(page.captchaUnavailable).toBe(false);
    expect(page.managedWidgetRendered).toBe(false);
  });

  it('acts on the first look when the script is already present, spending no grace', () => {
    const browser = { scriptLoaded: true, token: '' };
    const { page } = mountFallbackSlot(browser);

    expect(page.managedWidgetRendered).toBe(true);
    expect(page.captchaUnavailable).toBe(false);
    expect(vi.getTimerCount(), 'a grace timer was armed for an answer already in hand').toBe(0);
  });

  it('decides nothing after teardown', () => {
    // The page returns this teardown from an $effect, so it runs on unmount and on every re-run. A
    // second look surviving it would flip the verdict on a component that is gone.
    const browser = { scriptLoaded: false, token: '' };
    const { page, teardown } = mountFallbackSlot(browser);
    teardown();
    vi.advanceTimersByTime(TURNSTILE_SCRIPT_GRACE_MS * 2);

    expect(page.captchaUnavailable).toBe(false);
    expect(page.managedWidgetRendered).toBe(false);
  });
});
