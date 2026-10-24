import { describe, expect, it, vi } from 'vitest';

/**
 * T5 — the single-image surface that renders a listing icon outside the store reads: the post
 * "Published with" chip. It goes through the listing-media gate.
 *
 * Imports only this surface's own entry point, so the file runs unchanged against code that
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
  const chip = (icon: Img | null, host: string, viewerBrowsingLevel?: number) =>
    projectPostAppChip(chipRow(icon), { host, hiddenListingIds: new Set(), viewerBrowsingLevel });

  it('an R icon is dropped on a non-red host, and the chip still links', () => {
    expect(chip(img('chip-r.png', R), 'civitai.com')).toEqual({
      slug: 'chip-app',
      name: 'Chip App',
      iconUrl: null,
    });
  });

  // The store's red-host rule: on a red host the chip icon shows within the non-red ceiling UNION
  // the viewer's opted-in levels. The viewer level here (PG|R = 5) is distinct from every
  // ceiling constant.
  it('on a red host an R icon shows to a viewer who opted into R, and to nobody else', () => {
    expect(chip(img('chip-r.png', R), 'civitai.red', PG | R)?.iconUrl).toBe('edge:chip-r.png@256');
    expect(chip(img('chip-r.png', R), 'civitai.red')?.iconUrl).toBeNull();
    expect(chip(img('chip-r.png', R), 'civitai.com', PG | R)?.iconUrl).toBeNull();
  });

  // Every moderation flag the gate reads, through the chip's own defensive reader
  // (`readChipIcon`), so a dropped or mis-mapped field for any one of them is caught.
  it.each([
    ['poi', true],
    ['minor', true],
    ['tosViolation', true],
    ['acceptableMinor', true],
    ['needsReview', 'minor'],
    ['blockedFor', 'tos'],
  ])('the %s flag on the chip icon drops it', (field, value) => {
    // Positive control: the same icon unflagged is shown, on the same host and viewer.
    expect(chip(img('chip-ok.png', PG), 'civitai.com')?.iconUrl).toBe('edge:chip-ok.png@256');
    const flagged = chip(img('chip-ok.png', PG, { [field]: value }), 'civitai.com');
    expect(flagged?.slug, 'the chip itself must still render').toBe('chip-app');
    expect(flagged?.iconUrl).toBeNull();
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

// The LISTING RATING reaches the chip's ceiling. Fixtures vary it on purpose: a `g` listing
// and a `pg13` listing with the same PG-13 icon must disagree off a red host.
describe('T5 — the listing rating caps a single-image surface', () => {
  const PG13 = NsfwLevel.PG13;

  it('post chip: the same split, and a red host never shows less than a non-red one', () => {
    const chipFor = (contentRating: string, host: string) =>
      projectPostAppChip(
        {
          name: 'Client',
          appBlocks: [
            {
              status: 'approved',
              currentVersionDeployedAt: new Date('2026-01-01T00:00:00Z'),
              appListing: {
                id: 'apl_chip2',
                slug: 'chip-two',
                name: 'Chip Two',
                status: 'approved',
                kind: 'onsite',
                contentRating,
                revisionOfId: null,
                icon: img('chip-pg13.png', PG13),
              },
            },
          ],
        },
        { host, hiddenListingIds: new Set() }
      )?.iconUrl;
    expect(chipFor('pg13', 'civitai.com')).toBe('edge:chip-pg13.png@256');
    expect(chipFor('g', 'civitai.com')).toBeNull();
    // On a red host with no viewer level the chip shows exactly what the non-red host shows: a
    // pg13 listing's PG-13 icon. A red ceiling of "the viewer level alone" (the public floor, PG)
    // would hide it — so this case is what separates the two red-host rules.
    expect(chipFor('pg13', 'civitai.red')).toBe('edge:chip-pg13.png@256');
  });
});

// The chip reads its row as `unknown`, so a moderation flag arriving as something other than a
// boolean must count as SET (fail-closed), never as clear.
describe('T5 — the chip icon reader fails closed on a malformed flag', () => {
  it.each([
    ['a string', 'yes'],
    ['a number', 1],
  ])('treats a tosViolation that is %s as flagged', (_label, value) => {
    const chip = projectPostAppChip(
      {
        name: 'Client',
        appBlocks: [
          {
            status: 'approved',
            currentVersionDeployedAt: new Date('2026-01-01T00:00:00Z'),
            appListing: {
              id: 'apl_chip3',
              slug: 'chip-three',
              name: 'Chip Three',
              status: 'approved',
              kind: 'onsite',
              contentRating: 'g',
              revisionOfId: null,
              icon: img('chip-flag.png', PG, { tosViolation: value }),
            },
          },
        ],
      },
      { host: 'civitai.com', hiddenListingIds: new Set() }
    );
    expect(chip?.slug, 'the chip itself must still render').toBe('chip-three');
    expect(chip?.iconUrl).toBeNull();
  });
});
