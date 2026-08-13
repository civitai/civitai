import { describe, expect, it } from 'vitest';

import {
  ALL_EDITOR_TABS,
  DEFAULT_EDITOR_TAB,
  EDITOR_TAB_LABELS,
  editorTabsFor,
  listingEditHref,
  resolveEditorTab,
} from '~/components/Apps/appListingEditorTabs';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';

/**
 * The canonical authoring page's TAB SET, pinned in BOTH directions.
 *
 * 🔴 "Both directions" is the point. Asserting only that an on-site listing HAS a
 * Manifest tab passes just as happily on an implementation that renders Manifest for
 * everything — and rendering it for an off-site listing is a guaranteed 404 (there is no
 * AppBlock to key `blocks.getMyAppManifest` with). Every case below therefore asserts a
 * presence AND the matching absence.
 */

const onsite = capabilitiesForKind('onsite');
const offsite = capabilitiesForKind('offsite');

describe('editorTabsFor — kind-derived tabs, pinned both directions', () => {
  it('ON-SITE owner: Details, Media, Manifest, Collaborators — in order', () => {
    expect(
      editorTabsFor({ kind: 'onsite', appBlockId: 'ab_1', role: 'owner', capabilities: onsite })
    ).toEqual(['details', 'media', 'manifest', 'collaborators']);
  });

  it('OFF-SITE owner: NO Manifest and NO Media — only Details + Collaborators', () => {
    const tabs = editorTabsFor({
      kind: 'offsite',
      appBlockId: null,
      role: 'owner',
      capabilities: offsite,
    });
    expect(tabs).toEqual(['details', 'collaborators']);
    // The two block-keyed surfaces are the ones that 404 without an AppBlock.
    expect(tabs).not.toContain('manifest');
    expect(tabs).not.toContain('media');
  });

  it('an EDITOR sees the same tab set as the owner — role does not narrow it', () => {
    // What differs for an editor is the CONTROLS inside the collaborators panel
    // (invite/remove are owner-only), not which tabs exist: `getMyListingForEdit`,
    // `getMyListingForApp`, `getMyAppManifest` and `list` all admit an ACCEPTED seat.
    for (const kind of ['onsite', 'offsite'] as const) {
      const capabilities = capabilitiesForKind(kind);
      const appBlockId = kind === 'onsite' ? 'ab_1' : null;
      expect(editorTabsFor({ kind, appBlockId, role: 'editor', capabilities })).toEqual(
        editorTabsFor({ kind, appBlockId, role: 'owner', capabilities })
      );
    }
  });

  /**
   * 🔴 THE TWO CLAUSES OF THE MANIFEST RULE ARE NOT REDUNDANT, and these two cases are
   * what make each one individually killable: each disagrees with the other in exactly
   * one direction, so deleting either clause turns exactly one of them red.
   */
  it('OFF-SITE listing that CARRIES a block: capability withholds Manifest', () => {
    // `mapAppBlockToListing` can mint `kind:'offsite'` WITH a non-null appBlockId. The
    // block id exists (so a block-presence check alone would offer the tab) but the kind
    // declares `submitVersion: false`, and the store presents the listing as external.
    const tabs = editorTabsFor({
      kind: 'offsite',
      appBlockId: 'ab_odd',
      role: 'owner',
      capabilities: offsite,
    });
    expect(tabs).not.toContain('manifest');
    // Media keys on the BLOCK, which this row has — so it IS offered here. That is the
    // asymmetry, spelled out: the two tabs do not share a predicate.
    expect(tabs).toContain('media');
  });

  it('ON-SITE listing with NO block yet: block-presence withholds Manifest and Media', () => {
    // `submitVersion` is `true` for on-site (so a capability check alone would offer the
    // tab), but there is no id to render either block-keyed surface with.
    const tabs = editorTabsFor({
      kind: 'onsite',
      appBlockId: null,
      role: 'owner',
      capabilities: onsite,
    });
    expect(tabs).toEqual(['details', 'collaborators']);
  });

  it('Details and Collaborators exist for every shape — both are listing-keyed', () => {
    for (const kind of ['onsite', 'offsite'] as const) {
      for (const appBlockId of ['ab_1', null]) {
        for (const role of ['owner', 'editor'] as const) {
          const tabs = editorTabsFor({
            kind,
            appBlockId,
            role,
            capabilities: capabilitiesForKind(kind),
          });
          expect(tabs).toContain('details');
          expect(tabs).toContain('collaborators');
        }
      }
    }
  });
});

describe('resolveEditorTab', () => {
  it('returns a tab that is in the allowed set', () => {
    expect(resolveEditorTab('media', ['details', 'media', 'collaborators'])).toBe('media');
  });

  it('🔴 falls back for a REAL tab that this listing may not open', () => {
    // A legacy `/apps/<block>/edit-manifest` deep link hitting an off-site listing.
    expect(resolveEditorTab('manifest', ['details', 'collaborators'])).toBe('details');
  });

  it('falls back for junk, for an array param, and for a missing value', () => {
    expect(resolveEditorTab('nonsense', ALL_EDITOR_TABS)).toBe(DEFAULT_EDITOR_TAB);
    expect(resolveEditorTab(undefined, ALL_EDITOR_TABS)).toBe(DEFAULT_EDITOR_TAB);
    expect(resolveEditorTab(['collaborators', 'media'], ALL_EDITOR_TABS)).toBe('collaborators');
  });

  it('falls back to the FIRST allowed tab when the default itself is not allowed', () => {
    expect(resolveEditorTab('nonsense', ['collaborators'])).toBe('collaborators');
  });
});

describe('listingEditHref', () => {
  it('builds the canonical listing-keyed href, encoding the id', () => {
    expect(listingEditHref('apl_1')).toBe('/apps/listing/apl_1/edit');
    expect(listingEditHref('apl_1', 'collaborators')).toBe(
      '/apps/listing/apl_1/edit?tab=collaborators'
    );
    expect(listingEditHref('a b/c', 'media')).toBe('/apps/listing/a%20b%2Fc/edit?tab=media');
  });
});

describe('the tab vocabulary is complete', () => {
  it('every tab that can be produced has a label and is in ALL_EDITOR_TABS', () => {
    const produced = new Set(
      (['onsite', 'offsite'] as const).flatMap((kind) =>
        ['ab_1', null].flatMap((appBlockId) =>
          editorTabsFor({
            kind,
            appBlockId,
            role: 'owner',
            capabilities: capabilitiesForKind(kind),
          })
        )
      )
    );
    expect(produced.size).toBeGreaterThan(0);
    for (const tab of produced) {
      expect(ALL_EDITOR_TABS).toContain(tab);
      expect(EDITOR_TAB_LABELS[tab]).toBeTruthy();
    }
    expect(ALL_EDITOR_TABS).toContain(DEFAULT_EDITOR_TAB);
  });
});
