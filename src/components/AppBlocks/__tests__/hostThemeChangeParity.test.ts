import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THEME_CHANGE host-surface LEDGER.
 *
 * THE BUG CLASS: App Blocks has more than one host component, and they do NOT
 * share a postMessage bridge — each registers its own handlers and its own
 * host→block pushes by hand (`IframeHost.tsx` for the model slot,
 * `PageBlockHost.tsx` for `/apps/run/<slug>`). A host→block push wired into ONE
 * of them and not the other leaves half the deployed blocks stuck on their
 * mount-time theme, and every per-component test still passes: each suite is
 * scoped to one surface, so none of them ever asks "did the OTHER host get it
 * too?".
 *
 * `hostHandlerParity.ts` cannot cover this. Its INVENTORY is the block→HOST
 * request protocol (the "no handler → the block hangs" class); `THEME_CHANGE`
 * is a HOST→block push, so it is legitimately absent there.
 *
 * WHAT THIS PINS — a RELATIONSHIP, not a component: the set of host surfaces is
 * DERIVED from the source (every non-test AppBlocks component that opens a
 * postMessage bridge via `usePostMessage`), not hardcoded, so the guard fails if
 * that set GROWS (a new host surface that forgot the push) as well as if an
 * existing host loses it. The behavioural half — that a toggle actually reaches
 * the frame — lives in the two `*ThemeChange.browser.test.tsx` suites.
 */

const HOST_DIR = join(__dirname, '..');

/** Strip block + line comments so a mention inside a comment can't satisfy the grep. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every AppBlocks component that owns a postMessage bridge to a block frame.
 * Derived, so a NEW host surface is force-enrolled rather than silently exempt.
 */
function discoverHostSurfaces(): string[] {
  return readdirSync(HOST_DIR)
    .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
    .filter((f) =>
      /\busePostMessage\s*\(/.test(stripComments(readFileSync(join(HOST_DIR, f), 'utf8')))
    )
    .sort();
}

describe('THEME_CHANGE host-surface ledger', () => {
  it('the set of postMessage host surfaces is exactly the two known hosts', () => {
    // A change here is not necessarily a bug — but it MUST be a decision. A new
    // host surface has to either push THEME_CHANGE (add it below) or state why
    // it does not.
    expect(discoverHostSurfaces()).toEqual(['IframeHost.tsx', 'PageBlockHost.tsx']);
  });

  it('EVERY host surface pushes THEME_CHANGE', () => {
    const missing = discoverHostSurfaces().filter(
      (f) => !/send\(\s*'THEME_CHANGE'/.test(stripComments(readFileSync(join(HOST_DIR, f), 'utf8')))
    );
    expect(missing).toEqual([]);
  });

  it('the grep is not vacuous — it rejects a comment-only mention', () => {
    // Positive control on the STRIPPER: without it, the long explanatory comment
    // each host carries about THEME_CHANGE would satisfy the check above on a
    // host that never actually calls send().
    const commentOnly = `
      // send('THEME_CHANGE', { theme });
      /* send('THEME_CHANGE', { theme }); */
      export function FakeHost() { usePostMessage({}); return null; }
    `;
    const stripped = stripComments(commentOnly);
    expect(/send\(\s*'THEME_CHANGE'/.test(stripped)).toBe(false);
    // ...while a real call site still matches.
    expect(/send\(\s*'THEME_CHANGE'/.test(stripComments("send('THEME_CHANGE', { theme });"))).toBe(
      true
    );
  });
});
