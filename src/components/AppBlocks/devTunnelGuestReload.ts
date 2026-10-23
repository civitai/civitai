import type { BlockHostSurface } from '~/components/AppBlocks/blockInitFragmentGate';

/**
 * Did the author's dev-tunnel app just RELOAD ITSELF inside the frame — so the host must
 * ask its parent for a freshly signed entry URL and remount?
 *
 * WHY THIS EXISTS. Vite's live reload is `location.reload()` inside the frame. Two
 * failures follow, and a remount with a fresh entry URL is the one answer to both:
 *   - the host's init controller stopped at BLOCK_READY, so the reloaded document never
 *     receives a BLOCK_INIT and never becomes ready;
 *   - the reload re-requests the frame's ORIGINAL entry URL, whose signed token is
 *     short-lived — once it has expired the reload is refused (401) and no app code runs.
 *
 * THE TWO SIGNALS, and why both — one per failure:
 *   - `BLOCK_HELLO` while ready: a NEW document announced itself after the app was ready.
 *     The SDK says hello once per document, before it can ack READY, so a hello on a ready
 *     host is a reload whose entry token was still valid.
 *   - a `load` while ready, when a load has ALREADY been seen since the last hello: the
 *     refused reload. It runs no app code, so it never says hello, but Chromium still fires
 *     `load` on the frame element (measured 2026-10-23, a 401 carrying
 *     X-Frame-Options: DENY).
 *
 * WHY "SINCE THE LAST HELLO", not "any load after ready" and not "the second load ever".
 *   - The first `load` can arrive AFTER BLOCK_READY: the app acks as soon as its module
 *     code receives the init, while `load` also waits for every image and stylesheet
 *     (measured in Chromium: READY at 24 ms, the first `load` at 624 ms). "Any load after
 *     ready" would remount on it, and the remounted frame would do it again — a loop.
 *   - An app whose boot navigates its document ONCE before READY (a `location.replace`, or
 *     Vite's "new dependencies optimized" reload) loads twice; counting loads over the
 *     frame's whole life would call the second one a reload, every time — a loop again.
 *     The second document's hello resets the count, so its own late `load` is a first.
 *   - Residual, stated rather than hidden: an app on an SDK that never says hello AND
 *     navigates during boot still reads as reloading. `@civitai/sdk` has said hello since
 *     its first release and `@civitai/app-sdk` since 2026-08, so that is a pre-2026-08 app.
 *
 * Every `load` must be OBSERVED for the count to mean anything, so the dev-tunnel host
 * mounts its frame client-side only (DevTunnelBlockHost): a frame in the server-rendered
 * HTML can finish loading before hydration attaches the listener.
 *
 * WHY `ready`. Before BLOCK_READY the controller is still re-posting BLOCK_INIT, so a
 * document that reloads during boot is served by the running handshake and needs no
 * remount.
 *
 * 🔴 DEV-TUNNEL ONLY. On every other surface the frame is a published bundle, a reload is
 * not part of anyone's edit loop, and the remount path (a fresh entry mint) does not
 * exist — so they stay exactly as they were.
 */
export type GuestFrameEvent = 'hello' | 'load';

export function isDevTunnelGuestReload(args: {
  surface: BlockHostSurface;
  event: GuestFrameEvent;
  /** `load` events on the current frame element since its last BLOCK_HELLO, INCLUDING
   *  the one being judged (reset by a hello, and when the element is remounted). */
  loadsSinceHello: number;
  status: 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token' | 'error';
}): boolean {
  const { surface, event, loadsSinceHello, status } = args;
  if (surface !== 'dev-tunnel' || status !== 'ready') return false;
  return event === 'hello' || loadsSinceHello >= 2;
}
