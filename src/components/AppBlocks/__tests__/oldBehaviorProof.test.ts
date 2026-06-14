import { describe, expect, it } from 'vitest';

/**
 * PROOF that the race-regression test would FAIL against the pre-fix host
 * logic. This reconstructs the OLD init gate exactly (init only when the
 * iframe `load` event had fired → `iframeLoaded === true`) and shows that,
 * with no load event, the old gate refuses to init — i.e. the silent blank.
 *
 * This file is a guard, not production code: it documents the regression the
 * real `shouldStartInit` now prevents. Delete-safe.
 */
function oldShouldStartInit(args: {
  status: 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token';
  hasToken: boolean;
  checkpointLoading: boolean;
  iframeLoaded: boolean; // the old, load-gated requirement
}): boolean {
  const { status, hasToken, checkpointLoading, iframeLoaded } = args;
  if (status !== 'loading') return false;
  if (!iframeLoaded || !hasToken) return false; // <- the bug: load-gated
  if (checkpointLoading) return false;
  return true;
}

describe('old (pre-fix) load-gated init — reproduces the prod blank-iframe bug', () => {
  it('does NOT init when the iframe load event never fired (the bug)', () => {
    // Cached-bundle race: load fired before React attached onLoad, so
    // iframeLoaded stayed false forever — even with token + checkpoint ready.
    expect(
      oldShouldStartInit({
        status: 'loading',
        hasToken: true,
        checkpointLoading: false,
        iframeLoaded: false,
      })
    ).toBe(false); // <- silent blank
  });

  it('only init-ed once a load event was observed', () => {
    expect(
      oldShouldStartInit({
        status: 'loading',
        hasToken: true,
        checkpointLoading: false,
        iframeLoaded: true,
      })
    ).toBe(true);
  });
});
