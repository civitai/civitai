let enabled = false;

/** Toggle gated logs added across the Signals/Metrics consumers. Off by default. */
export function setSignalDebug(value: boolean) {
  enabled = value;
}

export function isSignalDebugEnabled() {
  return enabled;
}

/**
 * Logs `[signal] {label}` plus an optional payload, but only when
 * `setSignalDebug(true)` (or `window.__signals.setDebug(true)`) has been called.
 * Keep payloads small and shallow — these fire on every render/transition.
 */
export function signalDebug(label: string, payload?: unknown) {
  if (!enabled) return;
  if (payload !== undefined) console.log(`[signal] ${label}`, payload);
  else console.log(`[signal] ${label}`);
}
