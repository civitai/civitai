import { describe, expect, it } from 'vitest';

import {
  buildScalarPatch,
  isOnsiteEdit,
  listingEditHeaderCopy,
  editContextToForm,
  hasScalarChanges,
  isApprovedEdit,
  type ListingEditContext,
} from '~/components/Apps/offsiteEditConfig';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * W13 — dual-mode edit wizard PURE config. Covers the prefill mapping
 * (`editContextToForm`), the minimal scalar diff (`buildScalarPatch` — only
 * changed fields, never `slug`, empty tagline/description → null) and the
 * status/change predicates.
 */

function makeCtx(overrides: Partial<ListingEditContext> = {}): ListingEditContext {
  return {
    parentId: 'apl_1',
    slug: 'vitrine',
    status: 'draft',
    hasPendingRevision: false,
    shadowId: null,
    scalars: {
      name: 'Vitrine',
      tagline: 'A gallery',
      description: 'Long description',
      category: 'utility',
      contentRating: 'g',
      externalUrl: 'https://vitrine.civitai.com/',
    },
    assets: {
      icon: { imageId: 1, url: 'https://cdn/icon' },
      cover: { imageId: 2, url: 'https://cdn/cover' },
      screenshots: [{ id: 's1', imageId: 3, url: 'https://cdn/s1', caption: null, order: 0 }],
    },
    ...overrides,
  };
}

describe('editContextToForm', () => {
  it('maps scalars to form values, filling slug and blanking null fields', () => {
    const form = editContextToForm(
      makeCtx({ scalars: { name: 'X', tagline: null, description: null, category: null, contentRating: null, externalUrl: null } })
    );
    expect(form.slug).toBe('vitrine');
    expect(form.name).toBe('X');
    expect(form.tagline).toBe('');
    expect(form.description).toBe('');
    expect(form.category).toBeNull();
    // A null contentRating clamps to the SFW default.
    expect(form.contentRating).toBe('g');
    expect(form.externalUrl).toBe('');
    expect(form.changelog).toBe('');
  });
});

/**
 * 🔴 KIND-AWARE EDITING. The canonical authoring page now defaults to the DETAILS tab,
 * which means an ON-SITE owner clicking "Edit" lands in this form — a population it never
 * saw while the default was the manifest tab. It is the off-site submit wizard's edit
 * mode, so without a kind branch it offers an on-site app an "App URL" step and an
 * OAuth-scope disclosure that mean nothing for it, and `buildScalarPatch` can emit an
 * `externalUrl` onto a listing whose CTA is its hosted page.
 *
 * `kind` is OPTIONAL on the context and absent ⇒ off-site, so every pre-existing fixture
 * and caller keeps its exact behaviour — the branch only narrows the new population.
 */
describe('kind-aware editing (isOnsiteEdit)', () => {
  it('an explicit onsite kind is on-site; offsite and ABSENT are not', () => {
    expect(isOnsiteEdit(makeCtx({ kind: 'onsite' }))).toBe(true);
    expect(isOnsiteEdit(makeCtx({ kind: 'offsite' }))).toBe(false);
    // 🔴 Back-compat: an older context with no kind must behave exactly as before.
    expect(isOnsiteEdit(makeCtx())).toBe(false);
  });

  it('🔴 an ON-SITE patch NEVER carries externalUrl, however the field changed', () => {
    const ctx = makeCtx({ kind: 'onsite' });
    const form = { ...editContextToForm(ctx), externalUrl: 'https://evil.example.com/' };
    const patch = buildScalarPatch(ctx, form);
    expect(patch.externalUrl).toBeUndefined();
    expect('externalUrl' in patch).toBe(false);
  });

  it('an ON-SITE patch still carries every OTHER changed scalar', () => {
    // The narrowing must be surgical: this is what stops "drop externalUrl" turning into
    // "the on-site details form saves nothing".
    const ctx = makeCtx({ kind: 'onsite' });
    const patch = buildScalarPatch(ctx, {
      ...editContextToForm(ctx),
      name: 'Renamed',
      externalUrl: 'https://evil.example.com/',
    });
    expect(patch.name).toBe('Renamed');
    expect(patch.externalUrl).toBeUndefined();
  });

  it('an OFF-SITE patch DOES carry externalUrl — the control that stops over-reach', () => {
    const ctx = makeCtx({ kind: 'offsite' });
    const patch = buildScalarPatch(ctx, {
      ...editContextToForm(ctx),
      externalUrl: 'https://moved.example.com/',
    });
    expect(patch.externalUrl).toBe('https://moved.example.com/');
  });

  it('a context with NO kind still carries externalUrl (unchanged behaviour)', () => {
    const ctx = makeCtx();
    const patch = buildScalarPatch(ctx, {
      ...editContextToForm(ctx),
      externalUrl: 'https://moved.example.com/',
    });
    expect(patch.externalUrl).toBe('https://moved.example.com/');
  });
});

describe('buildScalarPatch', () => {
  it('returns an empty patch when nothing changed', () => {
    const ctx = makeCtx();
    const patch = buildScalarPatch(ctx, editContextToForm(ctx));
    expect(patch).toEqual({});
    expect(hasScalarChanges(patch)).toBe(false);
  });

  it('includes only changed fields and never the slug', () => {
    const ctx = makeCtx();
    const form = { ...editContextToForm(ctx), name: 'Vitrine 2', slug: 'ignored-new-slug' };
    const patch = buildScalarPatch(ctx, form);
    expect(patch).toEqual({ name: 'Vitrine 2' });
    expect('slug' in patch).toBe(false);
    expect(hasScalarChanges(patch)).toBe(true);
  });

  it('sends an emptied tagline / description as null (clears the column)', () => {
    const ctx = makeCtx();
    const form = { ...editContextToForm(ctx), tagline: '', description: '' };
    const patch = buildScalarPatch(ctx, form);
    expect(patch.tagline).toBeNull();
    expect(patch.description).toBeNull();
  });

  it('captures a material URL + name + contentRating change', () => {
    const ctx = makeCtx();
    const form = {
      ...editContextToForm(ctx),
      externalUrl: 'https://new.example.com/',
      contentRating: 'r' as const,
    };
    const patch = buildScalarPatch(ctx, form);
    expect(patch.externalUrl).toBe('https://new.example.com/');
    expect(patch.contentRating).toBe('r');
  });

  it('captures a category change and a category clear', () => {
    const ctx = makeCtx();
    expect(buildScalarPatch(ctx, { ...editContextToForm(ctx), category: 'games' }).category).toBe('games');
    expect(buildScalarPatch(ctx, { ...editContextToForm(ctx), category: null }).category).toBeNull();
  });
});

describe('connect scope disclosure', () => {
  // 13 = UserRead(1) | ModelsRead(4) | ModelsWrite(8).
  const FULL = TokenScope.UserRead | TokenScope.ModelsRead | TokenScope.ModelsWrite;

  // Justifications are now SENSITIVE-only (UserRead + ModelsWrite are sensitive;
  // ModelsRead is not), so the disclosure keeps rationale for those two.
  function connectCtx(overrides: Partial<ListingEditContext> = {}): ListingEditContext {
    return makeCtx({
      connectClientId: 'oauth-1',
      connectAllowedScopes: FULL,
      connectRequestedScopes: FULL,
      connectScopeJustifications: { UserRead: 'reason', ModelsWrite: 'reason' },
      ...overrides,
    });
  }

  it('editContextToForm derives requestedScopes from the client + prunes stale/non-sensitive justifications', () => {
    const form = editContextToForm(
      connectCtx({
        connectAllowedScopes: TokenScope.UserRead, // client now only allows UserRead (sensitive)
        connectScopeJustifications: { UserRead: 'a', ModelsWrite: 'b' },
      })
    );
    expect(form.connectClientId).toBe('oauth-1');
    expect(form.requestedScopes).toBe(TokenScope.UserRead);
    // ModelsWrite is no longer in the derived set → its justification is pruned.
    expect(form.scopeJustifications).toEqual({ UserRead: 'a' });
  });

  it('editContextToForm drops a NON-SENSITIVE stored justification (no author input for it)', () => {
    const form = editContextToForm(
      connectCtx({ connectScopeJustifications: { ModelsRead: 'legacy', UserRead: 'keep' } })
    );
    // ModelsRead is non-sensitive → pruned; UserRead (sensitive) is kept.
    expect(form.scopeJustifications).toEqual({ UserRead: 'keep' });
  });

  it('no scope patch when nothing changed', () => {
    const ctx = connectCtx();
    const patch = buildScalarPatch(ctx, editContextToForm(ctx));
    expect('requestedScopes' in patch).toBe(false);
    expect('scopeJustifications' in patch).toBe(false);
  });

  it('sends the derived mask + shaped SENSITIVE justifications when a justification changed', () => {
    const ctx = connectCtx();
    const form = {
      ...editContextToForm(ctx),
      scopeJustifications: { UserRead: 'updated', ModelsWrite: 'reason' },
    };
    const patch = buildScalarPatch(ctx, form);
    expect(patch.requestedScopes).toBe(FULL);
    expect(patch.scopeJustifications).toEqual({ UserRead: 'updated', ModelsWrite: 'reason' });
  });

  it('re-enters review when the client allowedScopes DRIFTED from the stored snapshot', () => {
    // Approved snapshot was ModelsRead only; the client now allows FULL → the form
    // shows/submits FULL, so even an untouched-justification save re-snapshots.
    const ctx = connectCtx({
      connectRequestedScopes: TokenScope.ModelsRead,
      connectAllowedScopes: FULL,
    });
    const patch = buildScalarPatch(ctx, editContextToForm(ctx));
    expect(patch.requestedScopes).toBe(FULL);
  });

  it('no scope fields for a listing without a connect client', () => {
    const ctx = makeCtx({ connectClientId: null });
    const form = { ...editContextToForm(ctx), scopeJustifications: { ModelsRead: 'x' } };
    const patch = buildScalarPatch(ctx, form);
    expect('requestedScopes' in patch).toBe(false);
    expect('scopeJustifications' in patch).toBe(false);
  });
});

describe('isApprovedEdit', () => {
  it('is true only for an approved parent', () => {
    expect(isApprovedEdit(makeCtx({ status: 'approved' }))).toBe(true);
    expect(isApprovedEdit(makeCtx({ status: 'draft' }))).toBe(false);
    expect(isApprovedEdit(makeCtx({ status: 'pending' }))).toBe(false);
  });
});

/**
 * 🔴 THE HEADER BLURB, keyed on the SAME flag as the wizard shape.
 *
 * The defect this pins was observed in production: the canonical editor for an ON-SITE
 * listing rendered "Update your external-link app. Change the link, details, or
 * assets…" over an external-link icon, about an app with no link and no URL step. The
 * wizard SHAPE was already kind-aware; only the header was left behind.
 */
describe('listingEditHeaderCopy', () => {
  it('🔴 the ON-SITE blurb never promises a link', () => {
    const onsite = listingEditHeaderCopy(false);
    expect(onsite.kind).toBe('onsite');
    expect(onsite.blurb).not.toMatch(/\blinks?\b/i);
    expect(onsite.blurb).not.toMatch(/external/i);
    expect(onsite.blurb).not.toMatch(/\burl\b/i);
    // …and it still says what CAN be changed, so the fix is not "delete the sentence".
    expect(onsite.blurb).toMatch(/details/i);
    expect(onsite.blurb).toMatch(/assets/i);
  });

  it('the OFF-SITE blurb is UNCHANGED, character for character', () => {
    const offsite = listingEditHeaderCopy(true);
    expect(offsite.kind).toBe('offsite');
    // 🔴 A LITERAL, not a pattern derived from the implementation. An off-site listing
    // really does have a link, and this is the string that shipped.
    expect(offsite.blurb).toBe(
      'Update your external-link app. Change the link, details, or assets across the steps below, then save.'
    );
  });

  it('the two branches render DIFFERENT elements, so a test can pin STATE not spelling', () => {
    expect(listingEditHeaderCopy(true).testId).not.toBe(listingEditHeaderCopy(false).testId);
  });

  /**
   * 🔴 THE SEAM WITH THE WIZARD SHAPE. `showUrlStep` is `!isOnsiteEdit(edit)`, so an
   * absent kind must yield the OFF-SITE header for the same reason it yields the URL
   * step — one predicate, one answer. Asserting the composition rather than the two
   * halves is what stops the header promising a step the wizard does not render.
   */
  it('🔴 a header that mentions the link is rendered EXACTLY when the URL step is', () => {
    for (const ctx of [makeCtx({ kind: 'onsite' }), makeCtx({ kind: 'offsite' }), makeCtx()]) {
      const showUrlStep = !isOnsiteEdit(ctx);
      const copy = listingEditHeaderCopy(showUrlStep);
      expect(/\blink\b/i.test(copy.blurb), `kind=${String(ctx.kind)}`).toBe(showUrlStep);
    }
  });
});
