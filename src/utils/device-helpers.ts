export const isTouchDevice = () =>
  typeof document !== 'undefined' && 'ontouchstart' in document.documentElement;

export const isAndroidDevice = () => {
  if (typeof document === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.indexOf('android') > -1; //&& ua.indexOf("mobile");
};

/**
 * Is this Brave? `navigator.brave` is non-standard and only Brave exposes it, so anything else —
 * including a rejection — means "not Brave".
 *
 * ONE implementation on purpose. This was open-coded at two call sites (ad-blocking detection and
 * the web-push failure message) and the two already disagreed: one handled a rejected `isBrave()`
 * and the other left it as an unhandled rejection. Callers differ only in what they do with the
 * answer, never in how it is obtained.
 */
export const isBraveBrowser = async (): Promise<boolean> => {
  if (typeof navigator === 'undefined') return false;
  const brave = (navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } }).brave;
  try {
    return (await brave?.isBrave?.()) === true;
  } catch {
    return false;
  }
};
