// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as Trpc from '~/utils/trpc';

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
/** Matches the `useCurrentUser` mock below. */
const VIEWER_ID = 7;

const mocks = vi.hoisted(() => ({
  owned: [] as { id: number; name: string; slug: string; url: string; animated: boolean }[],
  recentUse: [] as { cosmeticId: number; lastUsedAt: string }[],
  attribution: [] as { id: number; creatorId: number | null }[],
  /** One entry per attribution REQUEST built, so the gate and the chunking are both observable. */
  attributionRequests: [] as number[][],
  /** Only non-constant so the fake can express "the answer changed". */
  attributionVersion: 1,
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
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: VIEWER_ID }) }));

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
        dataUpdatedAt: mocks.attributionVersion,
        isLoading: false,
      }));
    },
  },
}));

import { MantineProvider } from '@mantine/core';
import { StickerPlacementTray } from '~/components/Sticker/StickerPlacementTray';

/** Ids DESCEND as obtained order advances — see the file header. */
const sticker = (n: number, name: string, slug: string, createdById: number | null = null) => ({
  id: 500 - n,
  name,
  slug,
  url: `https://example.test/${n}.png`,
  animated: false,
  createdById,
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

const tray = () =>
  createElement(MantineProvider, null, createElement(StickerPlacementTray, { imageId: IMAGE_ID }));

/**
 * Returns the root as well as the container: one test has to re-render into the
 * SAME root to reach the state where the query data changes under a mounted
 * tray, which a second `createRoot` would not reproduce.
 */
const renderRoot = async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(container);
  await act(async () => {
    root.render(tray());
  });
  return { container, root };
};

const render = async () => (await renderRoot()).container;

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
  mocks.attributionRequests = [];
  document.body.innerHTML = '';
});

/**
 * Marks some of the owned stickers as made by the viewer, by rewriting the
 * collection — which is the only place the tray now looks. A fresh array each
 * time, so a re-render sees a changed reference exactly as a refetch would.
 */
const setMine = (ids: number[]) => {
  mocks.owned = mocks.owned.map((option) =>
    ids.includes(option.id)
      ? { ...option, createdById: VIEWER_ID }
      : { ...option, createdById: null }
  );
};

/** The chip's input is visually hidden, so it is driven rather than clicked. */
const toggleMineOnly = async (container: HTMLElement) => {
  const chip = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!chip) throw new Error('the "Made by you" chip is not rendered');
  await act(async () => {
    chip.click();
  });
};

/**
 * 🔴 THE CREATOR RIDES ON THE COLLECTION — DO NOT PUT A QUERY BACK.
 *
 * `createdById` is selected by `user.getCosmetics`, which every tray open fetches
 * anyway, so knowing who made a sticker costs no request. That is the whole
 * reason the chip can be shown to anyone who has made one instead of only to
 * heavy collectors.
 *
 * It was briefly a second procedure (`cosmetic.getStickerAttribution`) behind the
 * same `> 12` gate as search and sort. Measured on prod 2026-09-09: asking would
 * have meant an attribution round trip on every tray open for all 1,545 sticker
 * owners to serve the 123 who made one — about 16 wasted round trips per person
 * served, against a public procedure with no rate limit and no edge cache.
 *
 * The first test below is what stops that coming back.
 */
describe('the tray can narrow to stickers you made', () => {
  it('learns who made them without asking anything', async () => {
    setMine([OWNED[2].id, OWNED[5].id]);
    const container = await render();

    // Reported as text so a regression names what went out rather than printing
    // "expected 1 to be 0".
    expect(
      mocks.attributionRequests.length
        ? `asked about ${mocks.attributionRequests.flat().length} ids`
        : 'asked nothing'
    ).toBe('asked nothing');
    // And the chip is there anyway — which is what makes the assertion above a
    // statement about efficiency rather than about the feature being absent.
    expect(container.querySelector('input[type="checkbox"]') ? 'chip drawn' : 'chip missing').toBe(
      'chip drawn'
    );
  });

  it('shows only the ones the viewer created', async () => {
    setMine([OWNED[2].id, OWNED[5].id]);
    const container = await render();
    expect(slugs(container)).toHaveLength(OWNED.length);

    await toggleMineOnly(container);

    // Named rather than counted, so a revert says WHICH stickers came back.
    expect(slugs(container)).toEqual([OWNED[2].slug, OWNED[5].slug]);
  });

  /**
   * 🔴 THE CHIP IS NOT BEHIND THE SEARCH THRESHOLD, DELIBERATELY. Justin's call,
   * once it was free: show it to anyone who has made one. A creator holding three
   * stickers, two of them theirs, is exactly who wants this and would never have
   * reached a collection-size gate.
   */
  it('draws the chip for a light owner who made one, with no search or sort beside it', async () => {
    mocks.owned = OWNED.slice(0, 3);
    setMine([mocks.owned[1].id]);
    const container = await render();

    expect(container.querySelector('input[type="checkbox"]') ? 'chip drawn' : 'chip missing').toBe(
      'chip drawn'
    );
    // Search and sort DO stay behind the threshold — a light owner seeing three
    // controls over three stickers is a different change from the one approved.
    expect(container.querySelector('input[aria-label="Search your stickers"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Sort your stickers"]')).toBeNull();
  });

  it('draws no chip for someone who created none of them', async () => {
    setMine([]);
    const container = await render();

    // The search control proves the controls row rendered at all, so this absence
    // is about the chip and not about an empty tray.
    expect(container.querySelector('input[aria-label="Search your stickers"]')).not.toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  /**
   * 🔴 DO NOT SIMPLIFY `mineOnly` BACK TO THE RAW TOGGLE. This is the test that
   * says why the tray derives it as `mineOnlyRequested && madeByYou.size > 0`
   * instead of using the state directly.
   *
   * The chip is drawn on the same predicate, so with the raw toggle the two can
   * come apart the moment the collection changes underneath a mounted tray — a
   * purchase from the shop panel directly above it does exactly that. The chip
   * unmounts, the filter stays on, and the tray sits showing nothing with no
   * control on screen to clear it, on the paid surface right after money moved.
   */
  it('un-filters rather than stranding an empty tray when the creator set empties', async () => {
    setMine([OWNED[2].id, OWNED[5].id]);
    const { container, root } = await renderRoot();
    await toggleMineOnly(container);
    expect(slugs(container)).toEqual([OWNED[2].slug, OWNED[5].slug]);

    // What a refetch after a purchase does: same mounted tray, nothing of yours.
    setMine([]);
    await act(async () => {
      root.render(tray());
    });

    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    // The whole collection, not zero tiles. Asserted by count AND by a member, so
    // a revert fails saying the tray is empty rather than "expected 0 to be 14".
    expect(slugs(container)).toHaveLength(OWNED.length);
    expect(slugs(container)).toContain(OWNED[0].slug);
  });

  it('and the same sequence without the toggle looks identical — the control', async () => {
    // Without this, the assertion above would pass for a tray that simply never
    // filtered in the first place.
    setMine([OWNED[2].id, OWNED[5].id]);
    const { container, root } = await renderRoot();
    expect(slugs(container)).toHaveLength(OWNED.length);

    setMine([]);
    await act(async () => {
      root.render(tray());
    });

    expect(slugs(container)).toHaveLength(OWNED.length);
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
