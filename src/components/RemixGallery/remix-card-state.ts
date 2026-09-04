import { create } from 'zustand';

/**
 * The frame an image wears because somebody remixed it.
 *
 * Same shape as any `ContentDecoration` cosmetic — `cssFrame` plus `glow`, which
 * is all `TwCosmeticWrapper` reads — so it renders through the existing path
 * with no cosmetic row, no grant and no entitlement check.
 *
 * 🔴 It must never win over a cosmetic the owner actually has. Theirs is bought
 * or earned; this is automatic, and quietly painting over it would take away
 * something someone paid for. Call sites resolve the owner's first and fall back
 * to this.
 */
export const REMIX_FRAME = {
  glow: true,
  cssFrame: 'linear-gradient(45deg, #ffd24a 5%, #f5a524 50%, #ffe9a8 95%)',
} as const;

/**
 * Which card has its preview open, site-wide.
 *
 * One at a time and held outside the card, because opening a second must close
 * the first — a feed with three panels open over three thumbnails is unreadable,
 * and a card cannot close a sibling it does not know about.
 */
export const useRemixPeelStore = create<{
  openId: number | null;
  toggle: (id: number) => void;
  close: () => void;
}>((set) => ({
  openId: null,
  toggle: (id) => set((state) => ({ openId: state.openId === id ? null : id })),
  close: () => set({ openId: null }),
}));
