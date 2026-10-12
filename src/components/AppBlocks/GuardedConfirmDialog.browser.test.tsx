import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { CONFIRM_ARM_DELAY_MS, useConfirmArmDelay } from './GuardedConfirmDialog';

/**
 * The delay behind the spend confirms, on a FAKE clock.
 *
 * The host suites (`PageBlockHostRunConfirmedStep` / `PageBlockHostRunTraining`) prove the
 * real dialogs are wired to this hook, on real time. Real time cannot pin the delay's
 * LENGTH or the "starts over" rule without racing the thing it measures, so those are
 * pinned here, where time only moves when the test moves it.
 */

function Probe({ active = true }: { active?: boolean }) {
  const armed = useConfirmArmDelay(CONFIRM_ARM_DELAY_MS, active);
  return <span data-testid="armed">{armed ? 'armed' : 'waiting'}</span>;
}

const state = () => page.getByTestId('armed').element().textContent;
/** Mount the probe and hand back the render result (`act` itself resolves to nothing). */
async function mountProbe(active: boolean) {
  let view!: Awaited<ReturnType<typeof renderWithProviders>>;
  await act(async () => {
    view = await renderWithProviders(<Probe active={active} />);
  });
  return view;
}
const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
const fire = (target: EventTarget, type: string) =>
  act(async () => void target.dispatchEvent(new Event(type)));
async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
  await fire(document, 'visibilitychange');
}

describe('useConfirmArmDelay', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  test('the delay is one second', () => {
    expect(CONFIRM_ARM_DELAY_MS).toBe(1000);
  });

  test('waits the WHOLE delay after it appears — not armed one millisecond early', async () => {
    await act(async () => void renderWithProviders(<Probe />));
    expect(state()).toBe('waiting');
    await advance(CONFIRM_ARM_DELAY_MS - 1);
    expect(state()).toBe('waiting');
    await advance(1);
    expect(state()).toBe('armed');
  });

  test('losing window focus disarms it, and it stays disarmed while away', async () => {
    await act(async () => void renderWithProviders(<Probe />));
    await advance(CONFIRM_ARM_DELAY_MS);
    expect(state()).toBe('armed');
    await fire(window, 'blur');
    expect(state()).toBe('waiting');
    await advance(60_000);
    expect(state()).toBe('waiting');
  });

  test('regaining focus does NOT arm it at once — the whole delay starts over', async () => {
    await act(async () => void renderWithProviders(<Probe />));
    await advance(CONFIRM_ARM_DELAY_MS);
    await fire(window, 'blur');
    await fire(window, 'focus');
    expect(state()).toBe('waiting');
    await advance(CONFIRM_ARM_DELAY_MS - 1);
    expect(state()).toBe('waiting');
    await advance(1);
    expect(state()).toBe('armed');
  });

  test('a focus event part-way through the first wait restarts it', async () => {
    await act(async () => void renderWithProviders(<Probe />));
    await advance(CONFIRM_ARM_DELAY_MS - 100);
    await fire(window, 'focus');
    await advance(CONFIRM_ARM_DELAY_MS - 1);
    expect(state()).toBe('waiting');
    await advance(1);
    expect(state()).toBe('armed');
  });

  test('a hidden tab disarms it; becoming visible starts the whole delay over', async () => {
    await act(async () => void renderWithProviders(<Probe />));
    await advance(CONFIRM_ARM_DELAY_MS);
    await setVisibility('hidden');
    expect(state()).toBe('waiting');
    await advance(60_000);
    expect(state()).toBe('waiting');
    await setVisibility('visible');
    expect(state()).toBe('waiting');
    await advance(CONFIRM_ARM_DELAY_MS - 1);
    expect(state()).toBe('waiting');
    await advance(1);
    expect(state()).toBe('armed');
  });

  // ── Only the dialog in front counts down ─────────────────────────────────────
  test('a dialog that is NOT in front never arms, however long it waits or what events fire', async () => {
    await act(async () => void renderWithProviders(<Probe active={false} />));
    await advance(60_000);
    expect(state()).toBe('waiting');
    await fire(window, 'focus');
    await setVisibility('visible');
    await advance(60_000);
    expect(state()).toBe('waiting');
  });

  test('coming to the front starts the WHOLE delay — time spent covered does not count', async () => {
    const view = await mountProbe(false);
    await advance(60_000);
    await act(async () => void view.rerender(<Probe active />));
    expect(state()).toBe('waiting');
    await advance(CONFIRM_ARM_DELAY_MS - 1);
    expect(state()).toBe('waiting');
    await advance(1);
    expect(state()).toBe('armed');
  });

  test('being covered disarms an armed dialog, and uncovering starts the delay over', async () => {
    const view = await mountProbe(true);
    await advance(CONFIRM_ARM_DELAY_MS);
    expect(state()).toBe('armed');
    await act(async () => void view.rerender(<Probe active={false} />));
    expect(state()).toBe('waiting');
    await advance(60_000);
    expect(state()).toBe('waiting');
    await act(async () => void view.rerender(<Probe active />));
    expect(state()).toBe('waiting');
    await advance(CONFIRM_ARM_DELAY_MS - 1);
    expect(state()).toBe('waiting');
    await advance(1);
    expect(state()).toBe('armed');
  });
});
