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
 * WHY THE FRAME'S `load` EVENT, and not BLOCK_HELLO-after-ready. It is the only signal
 * the two cases share: a refused reload never runs the app, so it never says hello, but
 * Chromium still fires `load` on the frame element (measured 2026-10-23, a 401 carrying
 * X-Frame-Options: DENY).
 *
 * WHY THE SECOND LOAD, not "any load after ready". The FIRST `load` can arrive AFTER
 * BLOCK_READY: the app acks as soon as its module code receives the init, while `load`
 * also waits for every image and stylesheet (measured in Chromium: READY at 24 ms, the
 * first `load` at 624 ms). Treating that load as a reload would remount, and the
 * remounted frame would do it again — a loop. A missed first `load` (the frame is in the
 * server-rendered HTML and can finish loading before hydration attaches the listener)
 * errs the SAFE way: one real reload goes unanswered, which is exactly today's
 * behaviour, and the next one is answered.
 *
 * WHY `ready`. Before BLOCK_READY the controller is still re-posting BLOCK_INIT, so a
 * document that reloads during boot (e.g. Vite's "new dependencies optimized" reload) is
 * served by the running handshake and needs no remount.
 *
 * 🔴 DEV-TUNNEL ONLY. On every other surface the frame is a published bundle, a reload is
 * not part of anyone's edit loop, and the remount path (a fresh entry mint) does not
 * exist — so they stay exactly as they were.
 */
export function isDevTunnelGuestReload(args: {
  surface: BlockHostSurface;
  /** `load` events observed on the CURRENT frame element (reset when it is remounted). */
  loadsOnFrame: number;
  status: 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token' | 'error';
}): boolean {
  const { surface, loadsOnFrame, status } = args;
  return surface === 'dev-tunnel' && status === 'ready' && loadsOnFrame >= 2;
}
