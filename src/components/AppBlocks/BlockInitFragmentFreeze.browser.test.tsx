import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// eslint-disable-next-line import/first
import { useBlockIframeSrc } from '~/components/AppBlocks/useBlockIframeSrc';

/**
 * 🔴 THE FREEZE INVARIANT — the property the init-fragment fast path names as
 * its safety argument, and which an adversarial audit found had ZERO coverage
 * in either tier.
 *
 * The claim: `useBlockIframeSrc` captures its fragment fields at MOUNT, so a
 * later `theme` change cannot move the rendered `src`. That matters because
 * `theme` genuinely does change while a block is mounted (the viewer toggles
 * dark mode), and a changing `src` ATTRIBUTE navigates a third-party iframe —
 * at best a `hashchange` inside the block, at worst a reload that discards its
 * in-progress state. Today the host does not propagate live theme changes to
 * blocks at all, so the fast path must not introduce that.
 *
 * The audit's finding, reproduced before this file existed: replacing the
 * frozen ref with live `fields` (and full deps) survived BOTH suites — node
 * 31/31 and browser 38/38. So the invariant was asserted only in prose.
 *
 * WHY THIS TESTS THE HOOK AND NOT A HOST. The fast path ships GATED OFF (the
 * allowlist in `blockInitFragmentGate.ts` is empty), so a host-level test would
 * render a `src` with no fragment at all and could not observe the freeze —
 * it would be vacuous by construction. Driving the hook with `enabled: true`
 * exercises the invariant that the gate will eventually expose.
 *
 * WHY THE COMPONENT TIER. `useBlockIframeSrc` is a React hook; civitai's unit
 * project runs `environment: 'node'` with no renderer, so a hook cannot be
 * mounted there.
 */

const BASE_SRC = 'https://demo.civit.ai/';

/** Renders the hook's output and exposes levers to change each input. */
function FreezeProbe({ enabled = true }: { enabled?: boolean }) {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [instanceId, setInstanceId] = useState('bi_first');
  const [baseSrc, setBaseSrc] = useState(BASE_SRC);

  const src = useBlockIframeSrc(
    baseSrc,
    { theme, renderMode: 'iframe', blockInstanceId: instanceId },
    enabled
  );

  return (
    <div>
      <output data-testid="src">{src}</output>
      <button
        data-testid="toggle-theme"
        onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
      >
        toggle theme
      </button>
      <button data-testid="change-instance" onClick={() => setInstanceId('bi_second')}>
        change instance
      </button>
      <button data-testid="change-base" onClick={() => setBaseSrc('https://demo.civit.ai/other')}>
        change base
      </button>
    </div>
  );
}

/**
 * Read the probe's output, waiting for the commit first.
 *
 * React 18 renders through `createRoot`, which commits ASYNCHRONOUSLY, so a
 * synchronous DOM read straight after `renderWithProviders` finds an empty
 * container — which is exactly how this file failed on its first run (an empty
 * `<div />` and "Cannot find element with locator"). Every other browser suite
 * in this repo awaits before asserting for the same reason.
 */
async function readSrc(): Promise<string> {
  let text = '';
  await vi.waitFor(() => {
    const el = page.getByTestId('src').element();
    if (!el) throw new Error('probe not mounted yet');
    text = (el.textContent ?? '').trim();
    if (!text) throw new Error('probe rendered empty');
  });
  return text;
}

describe('useBlockIframeSrc — the mount-time FREEZE', () => {
  test('🔴 a theme change leaves the src BYTE-IDENTICAL', async () => {
    renderWithProviders(<FreezeProbe />);

    const before = await readSrc();
    // Positive control: the fragment really is present, so "unchanged" below is
    // a statement about the freeze and not about an empty string.
    expect(before).toContain('#civitai-block=v1');
    expect(before).toContain('theme=light');

    await page.getByTestId('toggle-theme').click();

    const after = await readSrc();
    expect(after).toBe(before);
    // …and specifically still says the MOUNT-time theme, not the current one.
    expect(after).toContain('theme=light');
    expect(after).not.toContain('theme=dark');
  });

  test('survives repeated theme toggles', async () => {
    renderWithProviders(<FreezeProbe />);
    const before = await readSrc();

    for (let i = 0; i < 4; i += 1) await page.getByTestId('toggle-theme').click();

    expect(await readSrc()).toBe(before);
  });

  test('🔴 a blockInstanceId change also leaves the src byte-identical', async () => {
    renderWithProviders(<FreezeProbe />);
    const before = await readSrc();
    expect(before).toContain('blockInstanceId=bi_first');

    await page.getByTestId('change-instance').click();

    expect(await readSrc()).toBe(before);
    expect(await readSrc()).not.toContain('bi_second');
  });

  test('baseSrc is deliberately NOT frozen — it still re-navigates', async () => {
    // The counterpart guarantee. Freezing `baseSrc` too would silently pin a
    // stale manifest src, which is a behaviour CHANGE, not a safety property.
    // The audit noted that freezing it also survives the suites; this is the
    // test that stops it.
    renderWithProviders(<FreezeProbe />);
    const before = await readSrc();
    expect(before).toContain('https://demo.civit.ai/#');

    await page.getByTestId('change-base').click();

    const after = await readSrc();
    expect(after).not.toBe(before);
    expect(after).toContain('https://demo.civit.ai/other#');
    // The FRAGMENT carried across is still the frozen one.
    expect(after).toContain('theme=light');
    expect(after).toContain('blockInstanceId=bi_first');
  });

  test('when the gate is OFF the src is the bare base, with no fragment at all', async () => {
    renderWithProviders(<FreezeProbe enabled={false} />);

    const src = await readSrc();
    expect(src).toBe(BASE_SRC);
    expect(src).not.toContain('civitai-block');
  });
});
