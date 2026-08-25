import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { MediaType } from '~/shared/utils/prisma/enums';

/**
 * Stand-in data for the remix-gallery card indicator while the treatment is
 * being chosen (ticket 868kumuhp).
 *
 * 🔴 TEMPORARY. Nothing here survives the decision. The shipping version reads a
 * batched count for the ids on the surface — the shape `getStickerPlacementCounts`
 * already uses, one query per 100 cards — not a function of the id.
 *
 * Density is the one thing this cannot be honest about. Production has 237 host
 * images with any approved entry, out of every image on the site, so a faithful
 * demo would show a badge on no card you ever scrolled past. This shows one on
 * roughly a ninth of them so the indicator can be judged at all; read it for fit
 * and behaviour, never for how busy the feed would look.
 */
const DEFAULT_MODULUS = 9;

export const demoRemixCount = (imageId: number, modulus = DEFAULT_MODULUS) =>
  imageId % modulus === 0 ? (imageId % 7) + 1 : 0;

/**
 * `?remixdemo=<n>` badges one card in n, so crowding can be judged at a density
 * the real data cannot yet produce. `1` badges every card.
 *
 * 🔴 Applied from an effect rather than read during render. The server has no
 * query string when it renders the markup, so reading it inline gives a
 * different first paint on the client — which is a hydration mismatch, and this
 * page has already produced one (a Badge inside a Text) whose only visible
 * symptom was the dev error overlay swallowing every click on the card.
 */
export const useRemixDemoDensity = () => {
  const modulus = useRemixPeelStore((state) => state.modulus);
  const setModulus = useRemixPeelStore((state) => state.setModulus);

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('remixdemo');
    const parsed = raw ? Number(raw) : NaN;
    const valid = Number.isInteger(parsed) && parsed > 0;
    const next = valid ? parsed : DEFAULT_MODULUS;
    if (next !== modulus) setModulus(next);
    // Whether the stand-in data is in play at all, which is now a different
    // question from what density it uses: without `?remixdemo=` the cards read
    // the real batched counts, and the demo has to be asked for.
    useRemixPeelStore.setState({ demoActive: valid });
  }, [modulus, setModulus]);

  return modulus;
};

/** Verified-live assets used as stand-in gallery entries. */
const DEMO_THUMBS = [
  { imageId: 140554938, url: '31c35265-587b-4170-b7fe-44ba5e21b7ba', username: 'Escorwn' },
  { imageId: 140554932, url: '1fc08b9b-462b-4ffb-9227-8a42c0310a82', username: 'signalofsolarum' },
  { imageId: 140554931, url: '51c9d355-a2ab-4f47-bb39-e58b9a82268d', username: 'kaelthas_art' },
  { imageId: 140554927, url: 'ed5b1dce-602c-4143-befe-5bf17f362853', username: 'Nonamedgg' },
  { imageId: 140554924, url: '4ffac08a-f686-48da-b149-e9224706c3f6', username: 'chamo9009' },
  { imageId: 140554923, url: 'ea3af848-a01b-453b-9c95-b56adb495c11', username: 'take3tu' },
  { imageId: 140555502, url: '0134d13b-0151-46ff-ab19-d3953096dc82', username: 'LaffyGaffy2089' },
];

export const demoRemixEntries = (imageId: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    ...DEMO_THUMBS[(imageId + index) % DEMO_THUMBS.length],
    // Shaped like a real entry so one component renders both. Every stand-in is
    // a still, but the real column is not — the first production row this was
    // measured against was a video.
    type: 'image' as MediaType,
    nsfwLevel: 1,
  }));

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

/** The remix frame for an image, or nothing when it has no entries. */
export const remixFrame = (imageId: number, modulus?: number) =>
  demoRemixCount(imageId, modulus) ? REMIX_FRAME : undefined;

/**
 * Whether this viewer has a real pointer.
 *
 * Desktop-only for this pass, by decision — the flyout is a hover affordance and
 * the touch story is deliberately unbuilt. Gates the indicator as well as the
 * panel: a badge that opens nothing is worse on a phone than no badge at all.
 *
 * Starts false and settles in an effect, because the server cannot know and a
 * value read during render would differ between the two and desynchronise
 * hydration.
 */
export const useFinePointer = () => {
  const [fine, setFine] = useState(false);
  useEffect(() => {
    setFine(window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  }, []);
  return fine;
};

/**
 * Which card has its preview open, site-wide.
 *
 * One at a time and held outside the card, because opening a second must close
 * the first — a feed with three panels open over three thumbnails is unreadable,
 * and a card cannot close a sibling it does not know about.
 */
export const useRemixPeelStore = create<{
  openId: number | null;
  modulus: number;
  /** `?remixdemo=` is present, so cards show stand-in data instead of real counts. */
  demoActive: boolean;
  toggle: (id: number) => void;
  close: () => void;
  setModulus: (modulus: number) => void;
}>((set) => ({
  openId: null,
  modulus: DEFAULT_MODULUS,
  demoActive: false,
  toggle: (id) => set((state) => ({ openId: state.openId === id ? null : id })),
  close: () => set({ openId: null }),
  setModulus: (modulus) => set({ modulus }),
}));
