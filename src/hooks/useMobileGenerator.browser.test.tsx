import { useEffect, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { useMobileGenerator } from '~/hooks/useMobileGenerator';
import { renderWithProviders } from '../../test/component-setup';

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useOptionalFeatureFlags: () => ({ mobileGenerator: true }),
}));

// The mobile generator replaces the desktop one the moment `useMobileGenerator()` turns true, and the
// form closes with it. On a landscape tablet the on-screen keyboard cuts the viewport under 500px
// tall; that must not read as a phone. A phone held sideways (a short screen) still must.
//
// Chromium has no real keyboard here, so the keyboard is a smaller iframe (`page.viewport`) while the
// emulated device screen (`Emulation.setDeviceMetricsOverride`, with touch for `pointer: coarse`)
// stays put — which is what a keyboard does on Android.

type Cdp = { send: (method: string, params?: object) => Promise<unknown> };
const client = () => cdp() as unknown as Cdp;
const desktopUserAgent = navigator.userAgent;

async function device(screen: [number, number], { touch = true } = {}) {
  await client().send('Emulation.setDeviceMetricsOverride', {
    width: screen[0],
    height: screen[1],
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: screen[0],
    screenHeight: screen[1],
  });
  await client().send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 5 });
  // A phone's browser asks for the mobile site; `isPhoneScreen` reads that, not just the screen.
  await client().send('Emulation.setUserAgentOverride', {
    userAgent: desktopUserAgent,
    userAgentMetadata: {
      platform: 'Android',
      platformVersion: '',
      architecture: '',
      model: '',
      mobile: touch,
    },
  });
}

function Probe() {
  const mobile = useMobileGenerator();
  // The probe re-renders on resize and prints the window it sees, so a test can wait for the
  // resize to land before it asserts the layout did not change.
  const [, rerender] = useState(0);
  useEffect(() => {
    const onResize = () => rerender((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return (
    <div>
      <textarea aria-label="Prompt" />
      <output data-testid="layout">{mobile ? 'mobile' : 'desktop'}</output>
      <output data-testid="size">{`${innerWidth}x${innerHeight}`}</output>
    </div>
  );
}

const layout = () => page.getByTestId('layout');

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

/** Resize the window and wait until the probe has seen it, then a frame for the media query. */
async function resize(width: number, height: number) {
  await page.viewport(width, height);
  await expect.element(page.getByTestId('size')).toHaveTextContent(`${width}x${height}`);
  await frame();
  await frame();
}

async function show(viewport: [number, number]) {
  await page.viewport(...viewport);
  const view = await renderWithProviders(<Probe />);
  await expect.element(page.getByTestId('size')).toHaveTextContent(`${viewport[0]}x${viewport[1]}`);
  return view;
}

afterEach(async () => {
  await client().send('Emulation.clearDeviceMetricsOverride');
  await client().send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await client().send('Emulation.setUserAgentOverride', { userAgent: desktopUserAgent });
});

describe('useMobileGenerator on touch devices', () => {
  test('a landscape tablet keeps the desktop generator when the keyboard shrinks the viewport', async () => {
    await device([1180, 820]);
    await show([1180, 820]);
    await expect.element(layout()).toHaveTextContent('desktop');

    await page.getByLabelText('Prompt').click();
    await resize(1180, 480);
    // The keyboard really did cut the viewport under 500px tall.
    expect(matchMedia('(pointer: coarse) and (max-height: 499px)').matches).toBe(true);

    await expect.element(layout()).toHaveTextContent('desktop');
    await expect.element(page.getByLabelText('Prompt')).toHaveFocus();
  });

  test('control: a narrow touch window is a phone, so the probe can read "mobile"', async () => {
    await device([1180, 820]);
    await show([1180, 820]);
    await expect.element(layout()).toHaveTextContent('desktop');
    await resize(600, 820);
    await expect.element(layout()).toHaveTextContent('mobile');
  });

  test('a phone held sideways gets the mobile generator, with or without the keyboard', async () => {
    await device([844, 390]);
    await show([844, 390]);
    await expect.element(layout()).toHaveTextContent('mobile');
    await resize(844, 180);
    await expect.element(layout()).toHaveTextContent('mobile');
  });

  test('a browser that keeps the screen in portrait terms still sees a landscape phone', async () => {
    await device([390, 844]);
    await show([844, 390]);
    await expect.element(layout()).toHaveTextContent('mobile');
  });

  test('rotating a phone from portrait to landscape stays mobile', async () => {
    await device([390, 844]);
    await show([390, 844]);
    await expect.element(layout()).toHaveTextContent('mobile');
    await device([844, 390]);
    await resize(844, 390);
    await expect.element(layout()).toHaveTextContent('mobile');
  });

  test('a phone-sized screen on a mouse device is not a phone', async () => {
    await device([844, 390], { touch: false });
    await show([844, 390]);
    await expect.element(layout()).toHaveTextContent('desktop');
  });
});
