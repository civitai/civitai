import { useEffect } from 'react';
import { installBrowserErrorLog } from '~/utils/feedback/browserErrorLog';

/**
 * Starts the bounded browser-error snapshot that a feedback submission attaches.
 *
 * Renders nothing. It is mounted from `_app.tsx` rather than from the feedback prompt because the
 * errors worth reporting happen BEFORE someone decides to file a report — a recorder that started
 * when the drawer opened would capture an empty buffer and look like the feature does not work.
 *
 * 🔴 IT IS NOT GATED ON THE FEEDBACK AREA FLAG, AND THAT IS DELIBERATE. The area flag governs
 * whether a report can be SUBMITTED; this governs whether a buffer exists in memory to attach if
 * one is. Gating on the flag would mean a reporter who opens the drawer the moment something
 * breaks gets a snapshot of only what happened after the flag resolved.
 *
 * Nothing here is in the request path — see the mechanism note in `browserErrorLog.ts`: `fetch` is
 * not patched, network capture is a passive `PerformanceObserver`, and the `console.error` wrapper
 * delegates before it records.
 */
export function BrowserErrorRecorder() {
  useEffect(() => installBrowserErrorLog(), []);
  return null;
}
