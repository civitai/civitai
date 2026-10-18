import { describe, expect, it, vi } from 'vitest';

/**
 * T5 — the two single-image surfaces that render a listing icon outside the store reads: the
 * run-page chrome icon and the post "Published with" chip. Both go through the listing-media gate.
 *
 * Imports only these surfaces' own entry points, so the file runs unchanged against code that
 * predates the gate — which is how its cases were shown to fail before the change.
 *
 * Levels: PG = 1, R = 4. Urls are pairwise distinct.
 */

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_BLUE = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE_ALIASES = 'civitai.red';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});
vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: (src: string, opts?: { width?: number }) => `edge:${src}@${opts?.width ?? 'auto'}`,
}));

import { NsfwLevel } from '~/server/common/enums';
import {
  readListingIconBySlugForRender,
  type ListingIconReadClient,
} from '~/server/services/blocks/app-listing-icon.service';
import { projectPostAppChip } from '~/server/services/blocks/post-app-chip.logic';

const { PG, R } = NsfwLevel;

type Img = ReturnType<typeof img>;

function img(url: string, nsfwLevel: number, over: Record<string, unknown> = {}) {
  return {
    url,
    nsfwLevel,
    ingestion: 'Scanned',
    needsReview: null as string | null,
    poi: false,
    minor: false,
    tosViolation: false,
    acceptableMinor: false,
    blockedFor: null as string | null,
    ...over,
  };
}

describe('T5 — the run-page chrome icon', () => {
  const client = (icon: Img | null, contentRating = 'g'): ListingIconReadClient =>
    ({
      appListing: { findUnique: vi.fn(async () => ({ contentRating, icon })) },
    } as unknown as ListingIconReadClient);

  it('an R icon on a non-red host is null (the chrome falls back to its glyph)', async () => {
    expect(await readListingIconBySlugForRender('app', client(img('run-r.png', R)))).toBeNull();
    expect(
      await readListingIconBySlugForRender('app', client(img('run-r.png', R)), {
        redCapable: false,
        viewerBrowsingLevel: PG | R,
      })
    ).toBeNull();
  });

  it('the same R icon on a red host shows for an R viewer, not for an anonymous one', async () => {
    expect(
      await readListingIconBySlugForRender('app', client(img('run-r.png', R)), {
        redCapable: true,
        viewerBrowsingLevel: PG | R,
      })
    ).toBe('edge:run-r.png@256');
    expect(
      await readListingIconBySlugForRender('app', client(img('run-r.png', R)), { redCapable: true })
    ).toBeNull();
  });

  it('a PG icon shows on a non-red host (positive control)', async () => {
    expect(await readListingIconBySlugForRender('app', client(img('run-pg.png', PG)))).toBe(
      'edge:run-pg.png@256'
    );
  });
});

describe('T5 — the post "Published with" chip icon', () => {
  const chipRow = (icon: Img | null) => ({
    name: 'Client',
    appBlocks: [
      {
        status: 'approved',
        currentVersionDeployedAt: new Date('2026-01-01T00:00:00Z'),
        appListing: {
          id: 'apl_chip',
          slug: 'chip-app',
          name: 'Chip App',
          status: 'approved',
          kind: 'onsite',
          contentRating: 'g',
          revisionOfId: null,
          icon,
        },
      },
    ],
  });
  const chip = (icon: Img | null, host: string) =>
    projectPostAppChip(chipRow(icon), { host, hiddenListingIds: new Set() });

  it('an R icon is dropped on a non-red host, and the chip still links', () => {
    expect(chip(img('chip-r.png', R), 'civitai.com')).toEqual({
      slug: 'chip-app',
      name: 'Chip App',
      iconUrl: null,
    });
  });

  it('the chip is not a red showcase: an R icon is dropped on a red host too', () => {
    expect(chip(img('chip-r.png', R), 'civitai.red')?.iconUrl).toBeNull();
  });

  it('a PG icon is shown (positive control)', () => {
    expect(chip(img('chip-pg.png', PG), 'civitai.com')?.iconUrl).toBe('edge:chip-pg.png@256');
  });

  it('a still-scanning icon is dropped', () => {
    expect(chip(img('chip-scan.png', PG, { ingestion: 'Pending' }), 'civitai.com')?.iconUrl).toBe(
      null
    );
  });
});
