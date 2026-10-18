import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative, resolve } from 'path';
import { stripSourceComments } from '~/components/AppBlocks/stripSourceComments';

/**
 * SEAM GUARD — the App Store listing-media CALL-SITE LEDGER.
 *
 * Every public render of a listing's icon, cover or screenshots must decide per image, per
 * request, through `listing-media-audience.ts`. That only holds while nobody adds a surface that
 * hydrates a listing image and renders its url raw. This file pins two sets, by equality, so it
 * fails when either GROWS (a new surface that has not decided) or SHRINKS (a surface stopped
 * going through the gate, or a ledger entry went stale):
 *
 *   1. PROJECTORS — modules that use the listing-media url builders or the gate.
 *   2. UNGATED HYDRATIONS — modules that read a listing image `url` WITHOUT the gate's column
 *      set (a bare `icon/cover: { select: { url: true } }`, or a raw join on
 *      `al.icon_id` / `al.cover_id` that does not also read the level). Each is an author or
 *      moderator surface that must show what is attached, and says so here.
 *
 * The BEHAVIOUR of each gated surface is pinned in `listing-media-audience.test.ts`,
 * `listing-media-audience.seam.test.ts` and `app-sub-listing-store.behavior.test.ts`.
 */

const SRC = resolve(__dirname, '../../../..'); // …/src

const toPosix = (p: string) => p.replace(/\\/g, '/');
const toRel = (full: string) => toPosix(relative(SRC, full));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const isTestPath = (rel: string) =>
  rel.includes('__tests__') || /\.test\.tsx?$/.test(rel) || /(^|\/)tests\//.test(rel);

const PRODUCTION = walk(SRC)
  .map((full) => ({ rel: toRel(full), full }))
  .filter(({ rel }) => !isTestPath(rel));

/** The module that DEFINES the raw builders — never a call site of itself. */
const RAW_DEFINITION = 'server/services/blocks/listing-media-url.ts';

const MEDIA_MODULE_IMPORT =
  /from\s*['"][^'"]*listing-media-(?:url|audience)(?:\.[jt]sx?)?['"]|import\(\s*['"][^'"]*listing-media-(?:url|audience)['"]/;
const MEDIA_CALL =
  /\b(?:listingIconUrl|listingCoverUrl|projectListingMedia|gatedListingIconUrl|gatedListingCoverUrl|gatedListingScreenshots|isListingImageVisible)\s*\(/;
const GATE_CALL =
  /\b(?:projectListingMedia|gatedListingIconUrl|gatedListingCoverUrl|gatedListingScreenshots|isListingImageVisible)\s*\(/;

/**
 * A listing image `url` read without the gate's columns. Three shapes: an icon/cover relation
 * selecting only `url`; a `screenshots` relation whose `image` selects only `url`; a raw join of
 * `"Image"` onto any `<alias>.icon_id` / `<alias>.cover_id` whose alias's level is never read.
 *
 * ⚠️ WHAT THIS CANNOT SEE: a hydration that DOES select the level columns and then renders the
 * url without calling the gate. Only the behaviour suites catch that shape; the projector half of
 * this ledger narrows where it could live.
 */
const UNGATED_PRISMA_MEDIA = /\b(?:icon|cover)\s*:\s*\{\s*select\s*:\s*\{\s*url\s*:\s*true\s*\}/;
const UNGATED_SCREENSHOT_MEDIA =
  /\bscreenshots\s*:\s*\{[\s\S]{0,600}?\bimage\s*:\s*\{\s*select\s*:\s*\{\s*url\s*:\s*true\s*\}/;
const RAW_JOIN = /JOIN\s+"Image"\s+(\w+)\s+ON\s+\1\.id\s*=\s*\w+\.(?:cover_id|icon_id)/g;

function isProjector(code: string): boolean {
  return MEDIA_MODULE_IMPORT.test(code) || MEDIA_CALL.test(code);
}

function isUngatedHydration(code: string): boolean {
  if (UNGATED_PRISMA_MEDIA.test(code) || UNGATED_SCREENSHOT_MEDIA.test(code)) return true;
  // A raw join counts as GATED only when the same source also reads that alias's level; otherwise
  // its url can reach a response raw. EVERY join is checked, not only the first.
  for (const m of code.matchAll(RAW_JOIN)) {
    if (!new RegExp(`\\b${m[1]}\\."nsfwLevel"`).test(code)) return true;
  }
  return false;
}

const CODE = new Map<string, string>();
for (const { rel, full } of PRODUCTION) {
  const raw = readFileSync(full, 'utf8');
  if (!/listing-media-|listingIconUrl|listingCoverUrl|url: true|\.(?:cover|icon)_id/.test(raw)) {
    continue;
  }
  CODE.set(rel, stripSourceComments(raw));
}

/** Modules that project listing media, and how. */
const EXPECTED_PROJECTORS: Record<
  string,
  'gated' | 'gate' | 'raw: author' | 'gated + raw: moderator'
> = {
  // The rule itself.
  'server/services/blocks/listing-media-audience.ts': 'gate',
  // Public card, detail, gallery and cover fallback through `projectListingMedia`; the raw
  // builders only for the moderator review-queue facts (`listingQueueFacts`).
  'server/services/blocks/app-listing.service.ts': 'gated + raw: moderator',
  // Sub-listing card: its own image and the parent cover/icon fallback.
  'server/services/blocks/app-sub-listing-store.service.ts': 'gated',
  // Run-page chrome icon.
  'server/services/blocks/app-listing-icon.service.ts': 'gated',
  // Post "Published with" chip icon.
  'server/services/blocks/post-app-chip.logic.ts': 'gated',
  // The owner's own "My apps" row: shows exactly what is attached.
  'server/services/blocks/app-access.service.ts': 'raw: author',
};

/** Modules that read a listing image url without the gate's columns — none of them public. */
const EXPECTED_UNGATED_HYDRATIONS: Record<string, string> = {
  'server/services/blocks/app-access.service.ts': "the owner's own My-apps row",
  'server/services/blocks/app-ownership-transfer.service.ts':
    'the ownership-transfer offer, shown to the two parties of the transfer',
  'server/services/blocks/offsite-listing.service.ts':
    "the author's edit prefill and the off-site moderator review queue",
  'server/services/blocks/publish-request.service.ts': 'the on-site moderator review queue',
};

describe('listing-media call-site ledger', () => {
  // POSITIVE CONTROL for the walk: a zero below would otherwise be a fact about the walk.
  it('the walk reaches the whole production tree and the modules under test', () => {
    expect(PRODUCTION.length).toBeGreaterThan(3000);
    for (const tree of ['components/', 'pages/', 'server/']) {
      expect(
        PRODUCTION.some(({ rel }) => rel.startsWith(tree)),
        tree
      ).toBe(true);
    }
    expect(CODE.has(RAW_DEFINITION)).toBe(true);
    expect(CODE.has('server/services/blocks/listing-media-audience.ts')).toBe(true);
  });

  // POSITIVE + NEGATIVE controls for both detectors, including the shapes main used to have.
  it('the detectors match what they claim to and nothing else', () => {
    expect(
      isProjector(`import { listingIconUrl } from '~/server/services/blocks/listing-media-url';`)
    ).toBe(true);
    expect(isProjector(`import * as m from './listing-media-audience';`)).toBe(true);
    expect(isProjector(`const u = listingCoverUrl(row.cover, null);`)).toBe(true);
    expect(isProjector(`const v = 'listingIconUrl';`)).toBe(false);
    expect(isProjector(`export const x = 1;`)).toBe(false);

    // The pre-gate hydrate select and the pre-gate sub-listing join.
    expect(isUngatedHydration(`icon: { select: { url: true } },`)).toBe(true);
    expect(isUngatedHydration(`cover: { select: { url: true } }`)).toBe(true);
    expect(
      isUngatedHydration(`pc.url AS parent_cover_url\n LEFT JOIN "Image" pc ON pc.id = al.cover_id`)
    ).toBe(true);
    // The gated shapes.
    expect(isUngatedHydration(`icon: { select: listingMediaImageSelect },`)).toBe(false);
    expect(
      isUngatedHydration(`pc."nsfwLevel" AS l\n LEFT JOIN "Image" pc ON pc.id = al.cover_id`)
    ).toBe(false);
    // The pre-gate screenshot hydration, and its gated form.
    expect(
      isUngatedHydration(
        `screenshots: {\n  where: { imageId: { not: null } },\n  select: { caption: true, image: { select: { url: true } } },\n}`
      )
    ).toBe(true);
    expect(
      isUngatedHydration(
        `screenshots: { select: { caption: true, image: { select: listingMediaImageSelect } } }`
      )
    ).toBe(false);
    // Every raw join is checked: a gated first join does not excuse an ungated second one, and the
    // listing alias need not be `al`.
    expect(
      isUngatedHydration(
        `pc."nsfwLevel" AS a\n LEFT JOIN "Image" pc ON pc.id = al.cover_id\n LEFT JOIN "Image" pi ON pi.id = l.icon_id`
      )
    ).toBe(true);
    // An unrelated url select (not under icon/cover/screenshots) is not this ledger's business.
    expect(isUngatedHydration(`image: { select: { url: true } }`)).toBe(false);
  });

  it('has exactly the ledgered projectors — no more, no fewer', () => {
    const found = [...CODE.entries()]
      .filter(([rel, code]) => rel !== RAW_DEFINITION && isProjector(code))
      .map(([rel]) => rel)
      .sort();
    expect(found).toEqual(Object.keys(EXPECTED_PROJECTORS).sort());
  });

  it('every gated projector actually calls the gate', () => {
    const gated = Object.entries(EXPECTED_PROJECTORS)
      .filter(([, role]) => role.startsWith('gated'))
      .map(([rel]) => rel);
    // Named rather than counted, so re-labelling an entry cannot empty this loop silently.
    expect(gated.sort()).toEqual([
      'server/services/blocks/app-listing-icon.service.ts',
      'server/services/blocks/app-listing.service.ts',
      'server/services/blocks/app-sub-listing-store.service.ts',
      'server/services/blocks/post-app-chip.logic.ts',
    ]);
    for (const rel of gated) {
      expect(CODE.has(rel), rel).toBe(true);
      expect(GATE_CALL.test(CODE.get(rel) ?? ''), rel).toBe(true);
    }
  });

  it('has exactly the ledgered ungated hydrations — no more, no fewer', () => {
    const found = [...CODE.entries()]
      .filter(([, code]) => isUngatedHydration(code))
      .map(([rel]) => rel)
      .sort();
    expect(found).toEqual(Object.keys(EXPECTED_UNGATED_HYDRATIONS).sort());
  });
});
