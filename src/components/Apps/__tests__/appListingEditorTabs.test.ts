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
  it('ON-SITE owner on a LIVE listing: every tab, in order', () => {
    expect(
      editorTabsFor({
        kind: 'onsite',
        appBlockId: 'ab_1',
        role: 'owner',
        status: 'approved',
        capabilities: onsite,
      })
    ).toEqual([
      'details',
      'media',
      'manifest',
      'earnings',
      'collaborators',
      'publishing',
      'history',
    ]);
  });

  it('OFF-SITE owner: NO Manifest and NO Media — only Details + Collaborators', () => {
    const tabs = editorTabsFor({
      kind: 'offsite',
      appBlockId: null,
      role: 'owner',
      status: 'approved',
      capabilities: offsite,
    });
    expect(tabs).toEqual(['details', 'collaborators', 'publishing', 'history']);
    // The two block-keyed surfaces are the ones that 404 without an AppBlock.
    expect(tabs).not.toContain('manifest');
    expect(tabs).not.toContain('media');
  });

  it('an EDITOR sees the same CONTENT tabs as the owner — role narrows only Publishing', () => {
    // What differs for an editor on the content surfaces is the CONTROLS inside the
    // collaborators panel (invite/remove are owner-only), not which tabs exist:
    // `getMyListingForEdit`, `getMyListingForApp`, `getMyAppManifest` and `list` all admit
    // an ACCEPTED seat. `draft` is used here precisely because it is a status on which NO
    // publishing control exists for either role, so this case isolates the content half.
    for (const kind of ['onsite', 'offsite'] as const) {
      const capabilities = capabilitiesForKind(kind);
      const appBlockId = kind === 'onsite' ? 'ab_1' : null;
      expect(
        editorTabsFor({ kind, appBlockId, role: 'editor', status: 'draft', capabilities })
      ).toEqual(editorTabsFor({ kind, appBlockId, role: 'owner', status: 'draft', capabilities }));
    }
  });

  /**
   * 🔴 THE TWO CLAUSES OF THE MANIFEST RULE ARE NOT REDUNDANT, and these two cases are
   * what make each one individually killable: each disagrees with the other in exactly
   * one direction, so deleting either clause turns exactly one of them red.
   */
  it('🔴 OFF-SITE listing that CARRIES a block: the CAPABILITY withholds Manifest AND Media', () => {
    // `mapAppBlockToListing` can mint `kind:'offsite'` WITH a non-null appBlockId. The
    // block id exists — so a block-presence check ALONE would offer both tabs — but the
    // kind declares `submitVersion: false` and `listingMedia: false`, and the store
    // presents the listing as external.
    //
    // 🔴 THIS IS THE CASE THAT MAKES THE CAPABILITY CLAUSE KILLABLE. It is the only shape
    // where the capability and the block-presence check disagree in this direction, so
    // flipping `CAPABILITIES_BY_KIND.offsite.listingMedia` to `true` (what
    // https://github.com/civitai/civitai/issues/3893 would do) reddens exactly here.
    const tabs = editorTabsFor({
      kind: 'offsite',
      appBlockId: 'ab_odd',
      role: 'owner',
      status: 'approved',
      capabilities: offsite,
    });
    expect(tabs).not.toContain('manifest');
    expect(tabs).not.toContain('media');
    // 🔴 And no EARNINGS: `BlockBuzzAttribution` is keyed on `appBlockId` + a snapshotted
    // owner, so an off-site listing has no row that could ever be attributed to it and
    // `getAppEarnings` refuses it with `unsupportedKind`. Rendering the tab would be
    // rendering a guaranteed refusal.
    expect(tabs).not.toContain('earnings');
    expect(tabs).toEqual(['details', 'collaborators', 'publishing', 'history']);
  });

  it('🔴 ON-SITE listing with NO block yet: BLOCK-PRESENCE withholds Manifest and Media', () => {
    // `submitVersion` and `listingMedia` are both `true` for on-site — so a capability
    // check ALONE would offer both tabs — but there is no id to render either block-keyed
    // surface with. This is the case that makes the block-presence clause killable, and
    // it is the mirror image of the off-site-with-a-block case above: the two clauses
    // disagree in opposite directions, which is why neither is redundant.
    const tabs = editorTabsFor({
      kind: 'onsite',
      appBlockId: null,
      role: 'owner',
      status: 'approved',
      capabilities: onsite,
    });
    expect(tabs).toEqual(['details', 'collaborators', 'publishing', 'history']);
  });

  it('Details and Collaborators exist for every AUTHORABLE shape — both are listing-keyed', () => {
    for (const kind of ['onsite', 'offsite'] as const) {
      for (const appBlockId of ['ab_1', null]) {
        for (const role of ['owner', 'editor'] as const) {
          const tabs = editorTabsFor({
            kind,
            appBlockId,
            role,
            status: 'pending',
            capabilities: capabilitiesForKind(kind),
          });
          expect(tabs).toContain('details');
          expect(tabs).toContain('collaborators');
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * THE STATUS BRANCH — the security core
 * ------------------------------------------------------------------ */

/**
 * 🔴 THE NARROWED TAB SET FOR A NON-AUTHORABLE LISTING, PINNED ONE WITHHELD TAB AT A TIME.
 *
 * This route used to refuse `removed` and `rejected` outright. `getAppListingAuthoringContext`
 * now opens on them so an OWNER can reach their own Republish — an owner Unpublish and a
 * moderator takedown both write `status='removed'`, so refusing the page made an owner
 * unpublish a one-way door only a moderator could reopen (civitai/civitai#4218). The whole
 * safety of that change rests on THIS function withholding the content tabs, so each one gets
 * its own named case rather than a single aggregate `toEqual`: an aggregate assertion tells a
 * future reader that "the set changed", where these tell them WHICH guarantee broke.
 */
describe('🔴 a NON-AUTHORABLE listing gets the narrowed set — one case per withheld tab', () => {
  const removedOwner = {
    kind: 'onsite',
    appBlockId: 'ab_rm',
    role: 'owner',
    status: 'removed',
    capabilities: onsite,
  } as const;

  it('🔴 NEVER Collaborators — an invite accepted on a delisted app still mints repo WRITE', () => {
    // 🔴 THE SECURITY-CRITICAL ABSENCE, and the reason the page-level refusal could be
    // relaxed at all. `respondToInvite` grants Forgejo `write` on `civitai-apps/<slug>` as
    // part of accepting a seat. While this route was open on `removed` with an unconditional
    // Collaborators tab, an owner could invite someone onto a moderator-delisted app and the
    // acceptance would mint that grant — which is exactly what the old status gate was added
    // to stop. The tab is a UI narrowing, never the gate: `inviteCollaborator` and
    // `respondToInvite` refuse a non-authorable listing server-side, and
    // `app-collaborator.seat-grant-status.test.ts` is what pins that half.
    expect(editorTabsFor(removedOwner)).not.toContain('collaborators');
  });

  it('🔴 NEVER Details — `getMyListingForEdit` refuses a removed listing outright', () => {
    // Unconditional until this change, which is what made the whole set unsafe. The proc
    // behind the panel throws FORBIDDEN ('removed by a moderator and can no longer be
    // edited'), so the tab could only ever mount a doomed editor.
    expect(editorTabsFor(removedOwner)).not.toContain('details');
  });

  it('🔴 NEVER Media — content edits on a delisted listing are refused by the same proc', () => {
    // `appBlockId` is NON-NULL in this fixture and `listingMedia` is `true` for on-site, so
    // BOTH clauses of the media rule are satisfied. Only the status branch can withhold it —
    // which is precisely what makes this case able to kill a mutant that drops that branch.
    expect(editorTabsFor(removedOwner)).not.toContain('media');
  });

  it('🔴 NEVER Manifest — there is nothing to submit a version against', () => {
    // Same construction as Media: `submitVersion` is `true` for on-site and the block id is
    // present, so the status branch is the sole cause of this absence.
    expect(editorTabsFor(removedOwner)).not.toContain('manifest');
  });

  it('🔴 NEVER Earnings on a delisted app', () => {
    expect(editorTabsFor(removedOwner)).not.toContain('earnings');
  });

  it('🔴 the OWNER set is EXACTLY Publishing + History — nothing else may creep in', () => {
    // The aggregate, AFTER the five named absences rather than instead of them. It is what
    // catches a tab added in future that none of the cases above happens to name.
    expect(editorTabsFor(removedOwner)).toEqual(['publishing', 'history']);
  });

  it('🔴 a seated EDITOR on a removed listing gets History ALONE — never Publishing', () => {
    // Both takedown procs are owner-scoped server-side, so an editor offered Publishing gets
    // a guaranteed red toast. Same status as the owner case above, different role — so this
    // isolates the ROLE clause, which this change makes load-bearing for the first time.
    expect(editorTabsFor({ ...removedOwner, role: 'editor' })).toEqual(['history']);
  });

  it('🔴 a REJECTED listing gets History ALONE, even for the owner — nothing to publish', () => {
    // A rejected app never reached the store, so neither control exists and
    // `isPublishableListingStatus` withholds the tab. A DIFFERENT answer from the removed
    // owner case, so a mutant that treats every non-authorable status alike fails here.
    expect(editorTabsFor({ ...removedOwner, status: 'rejected' })).toEqual(['history']);
  });

  it('🔴 an UNKNOWN status falls into the narrowed branch, not the full one', () => {
    // Fail-closed. `canOpenListingAuthoringPage` refuses such a status at the server gate, so
    // this shape should be unreachable — but if it ever arrives, it must not be handed the
    // content tabs by default. `'quarantined'` is not a prefix or suffix of any real status.
    const tabs = editorTabsFor({ ...removedOwner, status: 'quarantined' });
    expect(tabs).not.toContain('collaborators');
    expect(tabs).not.toContain('details');
    expect(tabs).toEqual(['history']);
  });
});

/**
 * 🔴 THE DEEP-LINK ARM OF THE COLLABORATORS GUARD, NAMED.
 *
 * The tab-set cases above prove the tab is not OFFERED on a removed listing. They say
 * nothing about a caller who types `?tab=collaborators` — which is the shape an old
 * bookmark, a legacy `/apps/<block>/edit?tab=collaborators` redirect, or a curious user
 * actually produces. `resolveEditorTab` is the second gate and it is what makes the answer
 * safe; this is the case an auditor looks for and did not find.
 */
describe('🔴 a `?tab=collaborators` deep link on a REMOVED listing lands somewhere safe', () => {
  const removedOwner = {
    kind: 'onsite',
    appBlockId: 'ab_deep',
    role: 'owner',
    status: 'removed',
    capabilities: onsite,
  } as const;

  it('resolves to Publishing, never to Collaborators', () => {
    const allowed = editorTabsFor(removedOwner);
    // The parse-only allowlist still CONTAINS `collaborators` — that is deliberate, so a
    // legacy deep link survives an SSR hop instead of being flattened. The narrowing is
    // this call, against the tab set for THIS listing.
    expect(ALL_EDITOR_TABS).toContain('collaborators');
    expect(resolveEditorTab('collaborators', allowed)).toBe('publishing');
    expect(resolveEditorTab('collaborators', allowed)).not.toBe('collaborators');
  });

  it('the same link for a seated EDITOR resolves to History', () => {
    // A different answer from the owner case, so a mutant that hardcodes either literal
    // fails in exactly one of the two.
    const allowed = editorTabsFor({ ...removedOwner, role: 'editor' });
    expect(resolveEditorTab('collaborators', allowed)).toBe('history');
  });

  it('🔴 resolveEditorTab can NEVER return a tab outside `allowed` — the structural half', () => {
    // The two cases above are about one string. This is the property they are instances of,
    // driven across every tab name for every status × role the route opens on: whatever is
    // asked for, the answer is in the set the listing may open. Without it, the guard is
    // pinned only at the values someone thought to name.
    for (const status of ['draft', 'pending', 'approved', 'removed', 'rejected'] as const) {
      for (const role of ['owner', 'editor'] as const) {
        const allowed = editorTabsFor({ ...removedOwner, status, role });
        for (const asked of [...ALL_EDITOR_TABS, 'nonsense', '', 'collaborators']) {
          expect(allowed, `${status}/${role}/${asked}`).toContain(resolveEditorTab(asked, allowed));
        }
      }
    }
  });
});

describe('🔴 Publishing is offered only where a control exists, and only to the owner', () => {
  const base = {
    kind: 'offsite',
    appBlockId: null,
    role: 'owner',
    capabilities: offsite,
  } as const;

  it('appears on APPROVED (Unpublish) and on REMOVED (Republish)', () => {
    expect(editorTabsFor({ ...base, status: 'approved' })).toContain('publishing');
    expect(editorTabsFor({ ...base, status: 'removed' })).toContain('publishing');
  });

  it('🔴 is ABSENT on draft and pending — an app that was never live has nothing to take down', () => {
    // These two are AUTHORABLE, so they keep the full content set; the absence here is the
    // publishing clause alone, isolated from the status branch above.
    for (const status of ['draft', 'pending'] as const) {
      const tabs = editorTabsFor({ ...base, status });
      expect(tabs).not.toContain('publishing');
      // The control arm: the content tabs ARE there, so this is not an empty render.
      expect(tabs).toContain('details');
      expect(tabs).toContain('collaborators');
    }
  });

  it('🔴 is ABSENT for a seated EDITOR on a LIVE listing — a seat is not ownership', () => {
    const tabs = editorTabsFor({ ...base, status: 'approved', role: 'editor' });
    expect(tabs).not.toContain('publishing');
    // Control arm: the editor keeps every content tab on this status, so the absence is the
    // role clause and not a collapsed set.
    expect(tabs).toEqual(['details', 'collaborators', 'history']);
  });
});

describe('🔴 History is on EVERY shape the route opens — the set is never empty', () => {
  it('appears for both roles at every status, so `allowed[0]` always resolves', () => {
    // `resolveEditorTab` falls back to `allowed[0]` when the default (`details`) is not in
    // the set. An empty set would make that `undefined` and the page would render a Tabs
    // component with no value at all.
    for (const status of ['draft', 'pending', 'approved', 'removed', 'rejected'] as const) {
      for (const role of ['owner', 'editor'] as const) {
        for (const kind of ['onsite', 'offsite'] as const) {
          const tabs = editorTabsFor({
            kind,
            appBlockId: kind === 'onsite' ? 'ab_x' : null,
            role,
            status,
            capabilities: capabilitiesForKind(kind),
          });
          expect(tabs, `${kind}/${role}/${status}`).toContain('history');
          expect(tabs.length, `${kind}/${role}/${status}`).toBeGreaterThan(0);
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
            status: 'approved',
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
