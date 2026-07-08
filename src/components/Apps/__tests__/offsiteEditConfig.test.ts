import { describe, expect, it } from 'vitest';

import {
  buildScalarPatch,
  editContextToForm,
  hasScalarChanges,
  isApprovedEdit,
  type ListingEditContext,
} from '~/components/Apps/offsiteEditConfig';

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

describe('isApprovedEdit', () => {
  it('is true only for an approved parent', () => {
    expect(isApprovedEdit(makeCtx({ status: 'approved' }))).toBe(true);
    expect(isApprovedEdit(makeCtx({ status: 'draft' }))).toBe(false);
    expect(isApprovedEdit(makeCtx({ status: 'pending' }))).toBe(false);
  });
});
