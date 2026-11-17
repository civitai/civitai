/**
 * A window gets the generator's phone layout when its primary input is touch and either it is
 * narrow, or the device itself is a phone (see `isPhoneScreen`). `pointer`, not `any-pointer`: a
 * touch-screen laptop's primary pointer is its trackpad, so a narrowed laptop window keeps the
 * desktop layout.
 */
export const PHONE_MEDIA_QUERY = '(pointer: coarse) and (max-width: 767px)';

export const COARSE_POINTER_QUERY = '(pointer: coarse)';

/** The short side of a phone's screen, in CSS px, is under this; the smallest tablets are 744. */
export const PHONE_SCREEN_SHORT_SIDE = 500;

/**
 * A touch device whose screen is phone-sized: a phone held sideways is wider than 767px, so the
 * width query alone misses it. Read from the screen, not the window: the on-screen keyboard cuts a
 * landscape tablet's viewport under 500px tall, and that must not turn it into a phone mid-edit.
 * The short side, so it holds in either orientation and in browsers that never swap
 * `screen.width` and `screen.height`. False on the server.
 */
export function isPhoneScreen(): boolean {
  if (typeof window === 'undefined') return false;
  const { width, height } = window.screen;
  return (
    requestsMobileSite() &&
    window.matchMedia(COARSE_POINTER_QUERY).matches &&
    Math.min(width, height) < PHONE_SCREEN_SHORT_SIDE
  );
}

/**
 * False when the browser asks for the desktop site: a phone's "Desktop mode" sends a desktop user
 * agent but leaves `screen` alone, so the screen size alone would keep it on the phone layout.
 */
function requestsMobileSite(): boolean {
  const { navigator } = window;
  const hints = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (typeof hints?.mobile === 'boolean') return hints.mobile;
  return /Mobi|Android|iPhone|iPod/i.test(navigator.userAgent);
}
