import { afterEach, describe, expect, test, vi } from 'vitest';
import { isPhoneScreen } from '~/utils/phone-layout';

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function device({
  screen = { width: 412, height: 915 },
  coarse = true,
  userAgent = PHONE_UA,
  mobileHint,
}: {
  screen?: { width: number; height: number };
  coarse?: boolean;
  userAgent?: string;
  mobileHint?: boolean;
}) {
  vi.stubGlobal('window', {
    screen,
    matchMedia: () => ({ matches: coarse }),
    navigator: {
      userAgent,
      ...(mobileHint === undefined ? {} : { userAgentData: { mobile: mobileHint } }),
    },
  });
}

describe('isPhoneScreen', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('a phone, either way up', () => {
    device({});
    expect(isPhoneScreen()).toBe(true);
    device({ screen: { width: 915, height: 412 } });
    expect(isPhoneScreen()).toBe(true);
  });

  test("a phone in the browser's Desktop mode is not one", () => {
    // Chrome: the client hint says desktop.
    device({ userAgent: DESKTOP_UA, mobileHint: false });
    expect(isPhoneScreen()).toBe(false);
    // Browsers without client hints (Safari, Firefox): the user agent alone.
    device({ userAgent: DESKTOP_UA });
    expect(isPhoneScreen()).toBe(false);
  });

  test('a tablet and a mouse-driven window are not phones', () => {
    device({ screen: { width: 820, height: 1180 } });
    expect(isPhoneScreen()).toBe(false);
    device({ coarse: false });
    expect(isPhoneScreen()).toBe(false);
  });
});
