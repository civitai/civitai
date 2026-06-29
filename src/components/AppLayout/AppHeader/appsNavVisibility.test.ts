import { describe, expect, it } from 'vitest';
import { appsNavVisibility } from '~/components/AppLayout/AppHeader/appsNavVisibility';

// Scope-A invariant: the PUBLIC "Build apps" → /apps/get-started nav entry is
// visible whenever the public `appBlocksGetStarted` flag is on, INDEPENDENTLY of
// the mod-only `appBlocks` flag; the "Apps Marketplace" → /apps entry stays gated
// on `appBlocks` (mod-only) and never leaks to non-mods just because the public
// get-started flag is on.
describe('appsNavVisibility — public get-started vs mod-only marketplace', () => {
  it('shows the public get-started entry when appBlocksGetStarted is on', () => {
    const nav = appsNavVisibility({ appBlocksGetStarted: true, appBlocks: false });
    expect(nav.getStarted).toBe(true);
  });

  it('keeps the marketplace entry mod-gated even when the public flag is on', () => {
    // A non-mod (appBlocks off) with the public flag on sees ONLY get-started.
    const nav = appsNavVisibility({ appBlocksGetStarted: true, appBlocks: false });
    expect(nav.getStarted).toBe(true);
    expect(nav.marketplace).toBe(false);
  });

  it('shows BOTH entries for a moderator (both flags on) — distinct labels, no collision', () => {
    const nav = appsNavVisibility({ appBlocksGetStarted: true, appBlocks: true });
    expect(nav.getStarted).toBe(true);
    expect(nav.marketplace).toBe(true);
  });

  it('hides the get-started entry when the public flag is off (kill switch)', () => {
    const nav = appsNavVisibility({ appBlocksGetStarted: false, appBlocks: true });
    expect(nav.getStarted).toBe(false);
    // The marketplace entry is unaffected by the get-started kill switch.
    expect(nav.marketplace).toBe(true);
  });

  it('hides both entries when both flags are off', () => {
    const nav = appsNavVisibility({ appBlocksGetStarted: false, appBlocks: false });
    expect(nav.getStarted).toBe(false);
    expect(nav.marketplace).toBe(false);
  });

  it('treats undefined flags as off (default-deny on missing flags)', () => {
    const nav = appsNavVisibility({});
    expect(nav.getStarted).toBe(false);
    expect(nav.marketplace).toBe(false);
  });
});
