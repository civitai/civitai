import { useEffect } from 'react';
import { create } from 'zustand';

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
    const next = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MODULUS;
    if (next !== modulus) setModulus(next);
  }, [modulus, setModulus]);

  return modulus;
};

/** Verified-live assets used as stand-in gallery entries. */
const DEMO_THUMBS = [
  { url: '31c35265-587b-4170-b7fe-44ba5e21b7ba', username: 'Escorwn' },
  { url: '1fc08b9b-462b-4ffb-9227-8a42c0310a82', username: 'signalofsolarum' },
  { url: '51c9d355-a2ab-4f47-bb39-e58b9a82268d', username: 'kaelthas_art' },
  { url: 'ed5b1dce-602c-4143-befe-5bf17f362853', username: 'Nonamedgg' },
  { url: '4ffac08a-f686-48da-b149-e9224706c3f6', username: 'chamo9009' },
  { url: 'ea3af848-a01b-453b-9c95-b56adb495c11', username: 'take3tu' },
  { url: '0134d13b-0151-46ff-ab19-d3953096dc82', username: 'LaffyGaffy2089' },
];

export const demoRemixEntries = (imageId: number, count: number) =>
  Array.from({ length: count }, (_, index) => DEMO_THUMBS[(imageId + index) % DEMO_THUMBS.length]);

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
  toggle: (id: number) => void;
  close: () => void;
  setModulus: (modulus: number) => void;
}>((set) => ({
  openId: null,
  modulus: DEFAULT_MODULUS,
  toggle: (id) => set((state) => ({ openId: state.openId === id ? null : id })),
  close: () => set({ openId: null }),
  setModulus: (modulus) => set({ modulus }),
}));
