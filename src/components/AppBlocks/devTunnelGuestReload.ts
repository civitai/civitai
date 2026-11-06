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
 *   - a `load` while ready that leaves MORE loads than hellos on this frame (and at least
 *     two loads): the refused reload. It runs no app code, so it never says hello, but
 *     Chromium still fires `load` on the frame element (measured 2026-10-23, a 401
 *     carrying X-Frame-Options: DENY). Every document the app itself served said hello
 *     once; a load no hello accounts for is a document the app did not serve.
 *
 * THE COUNTS (`countGuestFrameEvent`). A hello and its own document's `load` may arrive
 * in EITHER order, and a document can say hello and then navigate away before its `load`
 * ever fires. So each `load` also caps the hello count at the load count: a hello no load
 * ever matched (its document navigated first) is forgotten rather than left to cancel a
 * later 401's load.
 *
 * Every rule here was a falsified alternative first — recorded so they are not re-derived:
 *   - not "any load after ready": the first `load` can arrive AFTER BLOCK_READY, since the
 *     app acks as soon as its module code receives the init while `load` also waits for
 *     every image and stylesheet (measured in Chromium: READY at 24 ms, the first `load`
 *     at 624 ms). That remounts on the first load, and the remounted frame does it again —
 *     a loop.
 *   - not "the second load ever": an app whose boot replaces its document ONCE before
 *     READY (a `location.replace`, Vite's "new dependencies optimized" reload) loads twice
 *     — a loop again. Both of its documents said hello, so 2 loads / 2 hellos is not one.
 *   - not "loads since the last hello": an app that starts its SDK late (e.g. in a React
 *     mount effect) says hello AFTER its own load, and the hello erased that load.
 *   - not "loads vs hellos, uncapped": a document that said hello and navigated before its
 *     `load` left a spare hello that hid the later 401's load.
 *   - "at least two loads" keeps an SDK that never says hello from reading its own first
 *     load as a reload.
 *
 * Residuals, stated rather than hidden — each needs the app to navigate during boot:
 *   - a document that navigates BEFORE its SDK says hello (or on an SDK that never does)
 *     reads as reloading: one extra remount per such boot, a loop only if every boot does.
 *   - a document that says hello and navigates before its `load`, FOLLOWED by one whose
 *     SDK says hello only after its own `load`: event for event that is a boot-time
 *     document replace, which must not remount, so a later 401 goes unanswered (the
 *     pre-fix freeze). The host cannot tell the two apart; this picks no-loop.
 *   The `page-elements` scaffold reaches `@civitai/sdk`'s `initialize()` synchronously
 *   from its entry module, so its hello precedes its `load`; `@civitai/blocks-react` has
 *   said hello since 2026-08-04, but only once a hook mounts, which can follow `load`.
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

/** The frame's `load`s and BLOCK_HELLOs since it was (re)mounted. */
export interface GuestFrameCounts {
  loads: number;
  hellos: number;
}

export const NO_GUEST_FRAME_EVENTS: GuestFrameCounts = { loads: 0, hellos: 0 };

/** Fold one event into the counts — see THE COUNTS above for the cap on `load`. */
export function countGuestFrameEvent(
  counts: GuestFrameCounts,
  event: GuestFrameEvent
): GuestFrameCounts {
  if (event === 'hello') return { loads: counts.loads, hellos: counts.hellos + 1 };
  const loads = counts.loads + 1;
  return { loads, hellos: Math.min(counts.hellos, loads) };
}

export function isDevTunnelGuestReload(args: {
  surface: BlockHostSurface;
  event: GuestFrameEvent;
  /** `countGuestFrameEvent` counts AFTER folding in the event being judged. */
  loads: number;
  hellos: number;
  status: 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token' | 'error';
}): boolean {
  const { surface, event, loads, hellos, status } = args;
  if (surface !== 'dev-tunnel' || status !== 'ready') return false;
  return event === 'hello' || (loads >= 2 && loads > hellos);
}
