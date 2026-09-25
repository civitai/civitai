export const isTouchDevice = () =>
  typeof document !== 'undefined' && 'ontouchstart' in document.documentElement;

export const isAndroidDevice = () => {
  if (typeof document === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.indexOf('android') > -1; //&& ua.indexOf("mobile");
};

/**
 * Is this Brave? `navigator.brave` is non-standard and only Brave exposes it, so anything else —
 * including a rejection, a throw, or no answer at all — means "not Brave".
 *
 * ONE implementation on purpose. The detection was open-coded at two call sites (ad-blocking
 * detection and the web-push failure message). At the time they were merged they already disagreed:
 * one handled a rejected `isBrave()` and the other left it as an unhandled rejection. Callers differ
 * only in what they do with the answer, never in how it is obtained.
 *
 * 🔴 CANNOT HANG, and that is load-bearing rather than defensive. One caller awaits this inside a
 * `catch` block, and a `finally` cannot run while its `catch` is suspended on a pending `await` — so
 * a promise that never settles would strand that caller's shared `busy` flag set, disabling every
 * push control in the tab until a reload, and never showing the error it was in the middle of
 * reporting. That is precisely the inert-button defect the push-failure work exists to remove, so
 * the answer is bounded: no answer within `BRAVE_PROBE_TIMEOUT_MS` is "not Brave", which only ever
 * costs the more generic copy.
 */
const BRAVE_PROBE_TIMEOUT_MS = 500;

export const isBraveBrowser = async (): Promise<boolean> => {
  if (typeof navigator === 'undefined') return false;
  try {
    // The property READ is inside the try as well as the call — a throwing `brave` getter would
    // otherwise escape, with the same consequence as the hang above.
    const brave = (navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } }).brave;
    if (typeof brave?.isBrave !== 'function') return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), BRAVE_PROBE_TIMEOUT_MS);
    });
    try {
      return (await Promise.race([brave.isBrave(), timeout])) === true;
    } finally {
      // Real Brave answers in well under the timeout, so without this the pending timer keeps a
      // handle alive on every call.
      if (timer) clearTimeout(timer);
    }
  } catch {
    return false;
  }
};
