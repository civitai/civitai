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
}

function Probe() {
  const mobile = useMobileGenerator();
  return (
    <div>
      <textarea aria-label="Prompt" />
      <output data-testid="layout">{mobile ? 'mobile' : 'desktop'}</output>
    </div>
  );
}

const layout = () => page.getByTestId('layout');

async function show(viewport: [number, number]) {
  await page.viewport(...viewport);
  return renderWithProviders(<Probe />);
}

afterEach(async () => {
  await client().send('Emulation.clearDeviceMetricsOverride');
  await client().send('Emulation.setTouchEmulationEnabled', { enabled: false });
});

describe('useMobileGenerator on touch devices', () => {
  test('a landscape tablet keeps the desktop generator when the keyboard shrinks the viewport', async () => {
    await device([1180, 820]);
    await show([1180, 820]);
    await expect.element(layout()).toHaveTextContent('desktop');

    await page.getByLabelText('Prompt').click();
    await page.viewport(1180, 480);
    // The keyboard really did cut the viewport under the old 500px cutoff.
    expect(innerHeight).toBe(480);
    expect(matchMedia('(pointer: coarse) and (max-height: 499px)').matches).toBe(true);

    await expect.element(layout()).toHaveTextContent('desktop');
    await expect.element(page.getByLabelText('Prompt')).toHaveFocus();
  });

  test('control: a narrow touch window is a phone, so the probe can read "mobile"', async () => {
    await device([1180, 820]);
    await show([1180, 820]);
    await expect.element(layout()).toHaveTextContent('desktop');
    await page.viewport(600, 820);
    await expect.element(layout()).toHaveTextContent('mobile');
  });

  test('a phone held sideways gets the mobile generator, with or without the keyboard', async () => {
    await device([844, 390]);
    await show([844, 390]);
    await expect.element(layout()).toHaveTextContent('mobile');
    await page.viewport(844, 180);
    await expect.element(layout()).toHaveTextContent('mobile');
  });

  test('a browser that keeps the screen in portrait terms still sees a landscape phone', async () => {
    await device([390, 844]);
    await show([844, 390]);
    await expect.element(layout()).toHaveTextContent('mobile');
  });

  test('rotating a phone from portrait to landscape stays mobile; a tablet rotating stays desktop', async () => {
    await device([390, 844]);
    await show([390, 844]);
    await expect.element(layout()).toHaveTextContent('mobile');
    await device([844, 390]);
    await page.viewport(844, 390);
    await expect.element(layout()).toHaveTextContent('mobile');

    await device([820, 1180]);
    await page.viewport(820, 1180);
    await expect.element(layout()).toHaveTextContent('desktop');
    await device([1180, 820]);
    await page.viewport(1180, 820);
    await expect.element(layout()).toHaveTextContent('desktop');
  });

  test('a short window on a mouse device is not a phone', async () => {
    await device([1180, 820], { touch: false });
    await show([1180, 400]);
    await expect.element(layout()).toHaveTextContent('desktop');
  });
});
