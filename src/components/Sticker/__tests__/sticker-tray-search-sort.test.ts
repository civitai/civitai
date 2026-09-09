// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as Trpc from '~/utils/trpc';
import { STICKER_OFFER_LIMIT } from '~/server/schema/cosmetic.schema';

/**
 * The tray's filter and its sort.
 *
 * 🔴 THE FIXTURE'S IDS MUST NOT ENCODE THE OBTAINED ORDER. `useOwnedSticker`
 * hands the tray its stickers newest-obtained first, and the sort leans on
 * `Array.prototype.sort` being stable to keep that order for anything never
 * placed — so a fixture whose ids ascend with obtained order lets a hand-written
 * `a.id - b.id` tie-break pass every assertion here. Ids below descend against
 * obtained order deliberately; with `id: i + 1` instead, the tie-break mutation
 * this file exists to catch goes green.
 */
const IMAGE_ID = 1;

const mocks = vi.hoisted(() => ({
  owned: [] as { id: number; name: string; slug: string; url: string; animated: boolean }[],
  recentUse: [] as { cosmeticId: number; lastUsedAt: string }[],
  attribution: [] as { id: number; creatorId: number | null }[],
  /** One entry per attribution REQUEST built, so the gate and the chunking are both observable. */
  attributionRequests: [] as number[][],
}));

vi.mock('~/components/Sticker/placement.util', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementUtil>()),
  useImagePlacementSpace: () => ({
    space: { mode: 'open', price: 100, ownerId: 999, freeSlots: 0, freeSlotsRemaining: 0 },
    isLoading: false,
  }),
  useFreePlacementStanding: () => ({ standing: undefined, isLoading: false }),
}));

vi.mock('~/store/sticker-placement-draft.store', () => ({
  useStickerPlacementDraftStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      targetImageId: IMAGE_ID,
      trayOpen: true,
      drafts: [],
      closeTray: () => undefined,
      setTray: () => undefined,
      begin: () => undefined,
    }),
}));

vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useOwnedSticker: () => ({ sticker: mocks.owned, isLoading: false }),
  useStickerRefill: () => () => ({ refill: true }),
}));

vi.mock('~/components/Sticker/StickerShopPanel', () => ({ StickerShopPanel: () => null }));
vi.mock('~/components/Sticker/StickerShopTile', () => ({ StickerShopTile: () => null }));
vi.mock('~/components/Sticker/use-sticker-drag-out', () => ({
  useStickerDragOut: () => ({ grab: () => undefined, dragging: false }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: {
    cosmetic: {
      getStickerBalances: { useQuery: () => ({ data: [] }) },
      getStickerRecentUse: { useQuery: () => ({ data: mocks.recentUse }) },
      getStickerOffers: { useQuery: () => ({ data: [] }) },
    },
    // `useOwnedStickerCreators` builds one query per chunk, so this records the
    // REQUESTS rather than an `enabled` flag: gated off, the list is empty and
    // nothing is asked for at all.
    useQueries: (
      build: (t: {
        cosmetic: {
          getStickerAttribution: (input: { ids: number[] }) => { ids: number[] };
        };
      }) => { ids: number[] }[]
    ) => {
      const requests = build({
        cosmetic: { getStickerAttribution: (input) => ({ ids: input.ids }) },
      });
      for (const request of requests) mocks.attributionRequests.push(request.ids);
      return requests.map((request) => ({
        data: mocks.attribution.filter((row) => request.ids.includes(row.id)),
        dataUpdatedAt: 1,
        isLoading: false,
      }));
    },
  },
}));

import { MantineProvider } from '@mantine/core';
import { StickerPlacementTray } from '~/components/Sticker/StickerPlacementTray';

/** Ids DESCEND as obtained order advances — see the file header. */
const sticker = (n: number, name: string, slug: string) => ({
  id: 500 - n,
  name,
  slug,
  url: `https://example.test/${n}.png`,
  animated: false,
});

// Name and slug carry DISJOINT tokens, so a search that matches one cannot be
// satisfied by the other half of the concatenation.
const OWNED = [
  sticker(0, 'Alpha', 'zulu'),
  sticker(1, 'Bravo', 'yankee'),
  sticker(2, 'Charlie', 'xray'),
  sticker(3, 'Delta', 'whiskey'),
  sticker(4, 'Echo', 'victor'),
  sticker(5, 'Foxtrot', 'uniform'),
  sticker(6, 'Golf', 'tango'),
  sticker(7, 'Hotel', 'sierra'),
  sticker(8, 'India', 'romeo'),
  sticker(9, 'Juliet', 'quebec'),
  sticker(10, 'Kilo', 'papa'),
  sticker(11, 'Lima', 'oscar'),
  sticker(12, 'Mike', 'november'),
  sticker(13, 'November', 'mike'),
];

const render = async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    createRoot(container).render(
      createElement(
        MantineProvider,
        null,
        createElement(StickerPlacementTray, { imageId: IMAGE_ID })
      )
    );
  });
  return container;
};

const slugs = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('img[alt^=":"]')).map((img) =>
    (img.getAttribute('alt') ?? '').replaceAll(':', '')
  );

const type = async (container: HTMLElement, value: string) => {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Search your stickers"]'
  );
  if (!input) throw new Error('the search control is not rendered');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
};

beforeEach(() => {
  mocks.owned = OWNED;
  mocks.recentUse = [];
  mocks.attribution = [];
  mocks.attributionRequests = [];
  document.body.innerHTML = '';
});

/** The chip's input is visually hidden, so it is driven rather than clicked. */
const toggleMineOnly = async (container: HTMLElement) => {
  const chip = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!chip) throw new Error('the "Made by you" chip is not rendered');
  await act(async () => {
    chip.click();
  });
};

/**
 * 🔴 THE THRESHOLD IS A DECISION, NOT AN OPTIMISATION — do not delete the gate
 * that these two assertions pin.
 *
 * "Made by you" was built on the EXISTING `cosmetic.getStickerAttribution`
 * rather than by adding `createdById` to `user.getCosmetics`, precisely because
 * it can be kept behind the same `> 12` threshold the search and sort controls
 * already use. Prod, 2026-09-09: 49 of 1,544 sticker owners hold more than 12,
 * and 30 of those 49 made at least one of their own. Remove the `enabled`
 * clause and the feature still works in every manual test while the other 1,495
 * owners each pay an uncached round trip on tray-open — which is the whole
 * reason the cheaper option was chosen over widening a shared payload.
 */
describe('the tray can narrow to stickers you made', () => {
  it('shows only the ones the viewer created', async () => {
    mocks.attribution = [
      { id: OWNED[2].id, creatorId: 7 },
      { id: OWNED[5].id, creatorId: 7 },
      { id: OWNED[8].id, creatorId: 999 },
    ];
    const container = await render();
    expect(slugs(container)).toHaveLength(OWNED.length);

    await toggleMineOnly(container);

    // Named rather than counted, so a revert says WHICH stickers came back.
    expect(slugs(container)).toEqual([OWNED[2].slug, OWNED[5].slug]);
  });

  it('draws no chip for someone who created none of them', async () => {
    mocks.attribution = [{ id: OWNED[0].id, creatorId: 999 }];
    const container = await render();

    // The search control proves the threshold controls rendered at all, so this
    // absence is about the chip and not about an empty tray.
    expect(container.querySelector('input[aria-label="Search your stickers"]')).not.toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('does not ask who made them at or below the search threshold', async () => {
    mocks.owned = OWNED.slice(0, 12);
    await render();

    // Reported as text rather than as a count, so a revert names how many ids
    // went out instead of printing "expected 1 to be 0".
    expect(
      mocks.attributionRequests.length
        ? `asked for ${mocks.attributionRequests.flat().length} ids`
        : 'asked for nothing'
    ).toBe('asked for nothing');
  });

  it('does ask above the threshold, so the assertion above can fail', async () => {
    await render();

    expect(
      mocks.attributionRequests.length
        ? `asked for ${mocks.attributionRequests.flat().length} ids`
        : 'asked for nothing'
    ).toBe(`asked for ${OWNED.length} ids`);
  });

  /**
   * 🔴 THE CAP IS SILENT, WHICH IS WHY THIS IS PINNED. `getStickerCosmeticsSchema`
   * maxes `ids` at 100; a single request carrying more fails zod, and a failed
   * query is indistinguishable from "you made none" — the chip simply never
   * appears. Five owners on prod hold more than 100 stickers, the largest 533,
   * and they are the heaviest collectors this control exists for.
   */
  it('never asks for more than the schema accepts, however many are owned', async () => {
    mocks.owned = Array.from({ length: 250 }, (_, i) => sticker(i, `Name${i}`, `slug-${i}`));
    await render();

    const oversized = mocks.attributionRequests.filter((ids) => ids.length > STICKER_OFFER_LIMIT);
    expect(oversized.map((ids) => ids.length)).toEqual([]);
    // Every id still asked about exactly once — chunking that drops or repeats
    // ids would leave the filter quietly wrong rather than absent.
    expect(mocks.attributionRequests.flat()).toHaveLength(250);
  });
});

describe('the tray sorts by what was placed most recently', () => {
  it('puts used stickers first, most recent first', async () => {
    mocks.recentUse = [
      { cosmeticId: OWNED[9].id, lastUsedAt: '2026-08-20T10:00:00.000Z' },
      { cosmeticId: OWNED[3].id, lastUsedAt: '2026-08-22T10:00:00.000Z' },
    ];

    expect(slugs(await render()).slice(0, 2)).toEqual(['whiskey', 'quebec']);
  });

  it('leaves the never-used tail in the order it arrived — obtained order', async () => {
    mocks.recentUse = [{ cosmeticId: OWNED[5].id, lastUsedAt: '2026-08-22T10:00:00.000Z' }];

    const rest = slugs(await render()).slice(1);

    // The order `useOwnedSticker` hands over, minus the one that was pulled to
    // the front. A hand-written tie-break on id would reverse this.
    expect(rest).toEqual(OWNED.filter((option) => option.id !== OWNED[5].id).map((o) => o.slug));
  });

  it('is the plain obtained order when nothing has been placed', async () => {
    // Negative control: without this, "used first" above could just be the input
    // order coming back unchanged.
    expect(slugs(await render())).toEqual(OWNED.map((option) => option.slug));
  });
});

describe('the tray filters on what was typed', () => {
  it('matches the name', async () => {
    const container = await render();
    await type(container, 'charl');

    expect(slugs(container)).toEqual(['xray']);
  });

  it('matches the slug, which is not a substring of its own name', async () => {
    const container = await render();
    await type(container, 'quebec');

    expect(slugs(container)).toEqual(['quebec']);
  });

  it('ignores case', async () => {
    const container = await render();
    await type(container, 'ECHO');

    expect(slugs(container)).toEqual(['victor']);
  });

  it('treats whitespace as no filter at all', async () => {
    const container = await render();
    await type(container, '   ');

    expect(slugs(container)).toHaveLength(OWNED.length);
  });

  it('keeps the search control while a term narrows the list', async () => {
    // 🔴 The control is gated on how many stickers are OWNED, not on how many
    // match. Gate it on the filtered list and the input unmounts under the
    // cursor as soon as the term gets narrow enough — focus lost, term stuck.
    const container = await render();
    await type(container, 'charl');

    expect(container.querySelector('input[aria-label="Search your stickers"]')).not.toBeNull();
    expect(slugs(container)).toHaveLength(1);
  });

  it('says so when nothing matches, and shows no tiles', async () => {
    const container = await render();
    await type(container, 'nothing-matches-this');

    expect(slugs(container)).toHaveLength(0);
    expect(container.textContent).toContain('No stickers match');
  });

  it('offers the shop rather than "no matches" when the collection is empty', async () => {
    // The two empty states are deliberately exclusive: owning nothing is the
    // shop's case, not the filter's.
    mocks.owned = [];
    const container = await render();

    expect(container.textContent).toContain('No stickers yet');
    expect(container.textContent).not.toContain('No stickers match');
  });
});
