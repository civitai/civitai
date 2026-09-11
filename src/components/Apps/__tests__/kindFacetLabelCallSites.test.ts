import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { LISTING_FACET_LABELS } from '~/components/Apps/listingKindLabels';
import { buildListingDetailRows } from '~/components/Apps/appListingDetailRows';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * 🔒 THE ENROLMENT LEDGER for the name of the KIND FACET — the word above the
 * thing, not the words for its values (those are `standaloneWordingCallSites`).
 *
 * ## WHY THIS FILE EXISTS — measured, not hypothetical
 *
 * The store's filter panel called this facet **"Type"**; the listing detail page's
 * Details rail called the same field **"Kind"**. One field, two words, on two
 * surfaces a viewer moves between in one session. Reported by a tester 2026-09-10:
 * *"why is it 'Kind' and not 'Type'? Should be 'Type', just like in the filter."*
 *
 * This is the sibling module's own defect one level up: the VALUE labels were
 * single-sourced into `listingKindLabels.ts` and the FACET label was left
 * open-coded at each site, so it drifted exactly as the values had.
 *
 * 🔴 SO THIS ASSERTS THE RELATIONSHIP, NOT THE WORD. Fixing two strings does not
 * remove the condition — the next surface to label this facet will hardcode
 * whichever word its author last saw. Every assertion below is written so that
 * changing `LISTING_FACET_LABELS.kind` to any other string keeps the suite green
 * while the two surfaces stay in agreement; only DRIFT fails it. A test spelling
 * `'Type'` would instead have to be edited on every copy change, which is how a
 * guard becomes something people bump rather than read.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The two surfaces that name this facet to a viewer today. */
const FACET_LABEL_CALL_SITES = [
  'src/components/Apps/AppsStoreFiltersDropdown.tsx',
  'src/components/Apps/appListingDetailRows.ts',
] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/**
 * Source with comments removed.
 *
 * 🔴 LOAD-BEARING, and it is here because the naive version FAILED ON ITSELF: the
 * first draft of this guard flagged `appListingDetailRows.ts` for "hardcoding" the
 * word, and the match was a COMMENT explaining the fix — prose naming the two words
 * that used to disagree. A guard that goes red when someone writes the word in a
 * sentence is one people learn to bump, which is worse than no guard. The claims
 * below are about CODE, so they read code.
 */
function readCode(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments, including JSX {/* … */} bodies
    .replace(/^\s*\/\/.*$/gm, ''); // line comments
}

describe('kind FACET label — enrolment ledger', () => {
  it('🔴 every enrolled call site imports the constant rather than spelling the word', () => {
    for (const rel of FACET_LABEL_CALL_SITES) {
      const src = read(rel);
      expect(src, `${rel} must import LISTING_FACET_LABELS.kind`).toContain(
        'LISTING_FACET_LABELS.kind'
      );
    }
  });

  it('🔴 no enrolled call site hardcodes the facet word in a user-facing string', () => {
    // Matches the literal in a quoted string or a JSX text node. Derived from the
    // constant, so this assertion follows a copy change instead of blocking it.
    const word = LISTING_FACET_LABELS.kind;
    const hardcoded = new RegExp(`(["'\`])${word}\\1|>\\s*${word}\\s*<`);
    for (const rel of FACET_LABEL_CALL_SITES) {
      const src = readCode(rel);
      expect(hardcoded.test(src), `${rel} hardcodes "${word}" instead of the constant`).toBe(false);
    }
  });

  it('🔴 the retired word "Kind" is gone from the enrolled surfaces as a LABEL', () => {
    // Scoped to a user-facing label. `key: 'kind'` is the row's stable identity and
    // must SURVIVE — a consumer selects on it — so this must not become a blanket
    // ban on the token. That distinction is the whole reason the assertion is
    // written against quoted display text rather than the identifier.
    const labelKind = /label:\s*(["'`])Kind\1|label=\{?(["'`])Kind\2|>\s*Kind\s*</;
    for (const rel of FACET_LABEL_CALL_SITES) {
      expect(labelKind.test(readCode(rel)), `${rel} still labels the facet "Kind"`).toBe(false);
    }
  });

  it('the row identity `kind` is UNCHANGED — only the label moved', () => {
    // The mirror of the assertion above, and the thing that would break a consumer
    // if the rename had gone one token too far.
    const rows = buildListingDetailRows(detailFixture(), {
      formatDate: () => 'some date',
    });
    const kindRow = rows.find((r) => r.key === 'kind');
    expect(kindRow, 'the kind row must still be addressable by key "kind"').toBeDefined();
    expect(kindRow?.label).toBe(LISTING_FACET_LABELS.kind);
  });

  it('the detail row and the filter panel agree — the actual claim', () => {
    // Both sides read from one constant, so agreement is structural rather than
    // coincidental. This asserts that the structure is what is in place: the
    // filter references the constant, and the row's rendered label IS the constant.
    const filterSrc = readCode('src/components/Apps/AppsStoreFiltersDropdown.tsx');
    expect(filterSrc).toContain('label={LISTING_FACET_LABELS.kind}');

    const rows = buildListingDetailRows(detailFixture(), { formatDate: () => 'some date' });
    expect(rows.find((r) => r.key === 'kind')?.label).toBe(LISTING_FACET_LABELS.kind);
  });
});

function detailFixture(): ListingDetail {
  return {
    id: 'l1',
    serialId: 1,
    slug: 'my-app',
    kind: 'onsite',
    collaborators: [],
    name: 'My App',
    tagline: null,
    description: null,
    category: 'utility',
    contentRating: null,
    isBeta: false,
    betaMessage: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    installCount: 0,
    sourceRepoUrl: null,
    updatedAt: '2026-03-04T05:06:07.000Z',
    screenshots: [],
    scopes: [],
    kindData: {
      kind: 'onsite',
      appBlockId: 'blk-1',
      hasPage: true,
      liveUrl: 'https://my-app.civit.ai',
    },
  };
}
