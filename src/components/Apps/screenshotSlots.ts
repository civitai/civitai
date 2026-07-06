/**
 * App Store Listings (W13) — P3a off-site submit screenshot batch slot logic
 * (PURE, no React). Extracted from `ExternalSubmitForm`'s asset step so the
 * multi-file batch invariant is unit-testable in isolation.
 *
 * The invariant: every file in a multi-file batch gets its OWN slot carrying a
 * STABLE id, and each per-file update patches THAT slot BY ID. The original
 * in-component code derived a slot index from `screenshots.length` captured in a
 * stale closure, so a multi-file batch collided every file onto one slot (each
 * write overwrote the previous). Assigning a stable id up-front and patching by
 * id removes the index/closure dependency entirely.
 */

export type ScreenshotSlotStatus = 'idle' | 'working' | 'attached' | 'processing' | 'error';

export type ScreenshotSlot = {
  /** Stable per-file id — the ONLY key used to address a slot after creation. */
  id: string;
  status: ScreenshotSlotStatus;
  imageId: number | null;
  message: string | null;
};

/** Deterministic stable id from a monotonic sequence number (e.g. a ref counter). */
export function makeScreenshotSlotId(seq: number): string {
  return `ss_${seq}`;
}

/**
 * Append a fresh slot (default 'working') carrying the given stable id. Returns a
 * new array — never mutates `slots`. `init` overrides the default fields.
 */
export function appendScreenshotSlot(
  slots: readonly ScreenshotSlot[],
  id: string,
  init?: Partial<Omit<ScreenshotSlot, 'id'>>
): ScreenshotSlot[] {
  return [...slots, { id, status: 'working', imageId: null, message: null, ...init }];
}

/**
 * Patch the slot whose id matches (the id itself is always preserved); a no-op if
 * no slot has that id. Returns a new array — never mutates `slots`.
 */
export function patchScreenshotSlot(
  slots: readonly ScreenshotSlot[],
  id: string,
  patch: Partial<Omit<ScreenshotSlot, 'id'>>
): ScreenshotSlot[] {
  return slots.map((s: ScreenshotSlot) => (s.id === id ? { ...s, ...patch, id } : s));
}
