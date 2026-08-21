import { describe, expect, it } from 'vitest';
import {
  OFFSITE_CATEGORY_OPTIONS,
  OFFSITE_CONTENT_RATING_OPTIONS,
  OFFSITE_SUBMIT_LIMITS,
  emptyOffsiteSubmitForm,
  isOffsiteSubmitFormValid,
  validateOffsiteSubmitForm,
  type OffsiteSubmitFormValues,
} from '../offsiteSubmitFormConfig';
import { MAX_EXTERNAL_URL_LENGTH } from '~/server/schema/blocks/external-app.schema';
import {
  OFFSITE_DESCRIPTION_MAX,
  OFFSITE_NAME_MAX,
} from '~/server/schema/blocks/offsite-listing.schema';

/**
 * W13 P3a — external-submit form validation mirror. Pins that the client mirror
 * matches the server `submitExternalListingSchema` bounds (https / slug / category
 * / name + description bounds) so inline errors can't drift from the server.
 */

const valid: OffsiteSubmitFormValues = {
  slug: 'my-external-app',
  name: 'My External App',
  externalUrl: 'https://example.com/app',
  tagline: 'a neat tool',
  description: 'does neat things',
  category: 'utility',
  contentRating: 'g',
  changelog: 'first submit',
};

describe('OFFSITE_SUBMIT_LIMITS — single source', () => {
  it('mirrors the schema consts (no drift)', () => {
    expect(OFFSITE_SUBMIT_LIMITS.nameMax).toBe(OFFSITE_NAME_MAX);
    expect(OFFSITE_SUBMIT_LIMITS.descriptionMax).toBe(OFFSITE_DESCRIPTION_MAX);
    expect(OFFSITE_SUBMIT_LIMITS.urlMax).toBe(MAX_EXTERNAL_URL_LENGTH);
  });
});

describe('validateOffsiteSubmitForm', () => {
  it('accepts a well-formed submission', () => {
    expect(validateOffsiteSubmitForm(valid)).toEqual({});
    expect(isOffsiteSubmitFormValid(valid)).toBe(true);
  });

  it('an empty form is invalid on slug + name (the homepage URL is now OPTIONAL)', () => {
    const errors = validateOffsiteSubmitForm(emptyOffsiteSubmitForm());
    expect(errors.slug).toBeDefined();
    expect(errors.name).toBeDefined();
    // externalUrl is optional in the merged model — a blank URL is valid (only a
    // PRESENT-but-malformed URL errors; see the non-https test below).
    expect(errors.externalUrl).toBeUndefined();
  });

  it('rejects a non-https URL', () => {
    expect(
      validateOffsiteSubmitForm({ ...valid, externalUrl: 'http://x.com' }).externalUrl
    ).toBeDefined();
  });

  it('rejects javascript: and data: URLs (phishing/XSS schemes)', () => {
    expect(
      validateOffsiteSubmitForm({ ...valid, externalUrl: 'javascript:alert(1)' }).externalUrl
    ).toBeDefined();
    expect(
      validateOffsiteSubmitForm({ ...valid, externalUrl: 'data:text/html,x' }).externalUrl
    ).toBeDefined();
  });

  it('rejects an over-long URL (> MAX_EXTERNAL_URL_LENGTH)', () => {
    const longUrl = `https://example.com/${'a'.repeat(MAX_EXTERNAL_URL_LENGTH)}`;
    expect(validateOffsiteSubmitForm({ ...valid, externalUrl: longUrl }).externalUrl).toBeDefined();
  });

  it('rejects a bad slug (regex) and out-of-bounds slug length', () => {
    expect(validateOffsiteSubmitForm({ ...valid, slug: 'Bad_Slug' }).slug).toBeDefined();
    expect(validateOffsiteSubmitForm({ ...valid, slug: 'ab' }).slug).toBeDefined();
    expect(validateOffsiteSubmitForm({ ...valid, slug: 'a'.repeat(41) }).slug).toBeDefined();
    // Must start with a letter.
    expect(validateOffsiteSubmitForm({ ...valid, slug: '1abc' }).slug).toBeDefined();
  });

  it('rejects an empty name and an over-long name', () => {
    expect(validateOffsiteSubmitForm({ ...valid, name: '' }).name).toBeDefined();
    expect(
      validateOffsiteSubmitForm({ ...valid, name: 'a'.repeat(OFFSITE_NAME_MAX + 1) }).name
    ).toBeDefined();
  });

  it('rejects an over-long description', () => {
    expect(
      validateOffsiteSubmitForm({ ...valid, description: 'a'.repeat(OFFSITE_DESCRIPTION_MAX + 1) })
        .description
    ).toBeDefined();
  });

  it('accepts a null category but rejects an unknown one', () => {
    expect(validateOffsiteSubmitForm({ ...valid, category: null }).category).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(validateOffsiteSubmitForm({ ...valid, category: 'nope' as any }).category).toBeDefined();
  });

  it('rejects an unknown content rating', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(
      validateOffsiteSubmitForm({ ...valid, contentRating: 'xxx' as any }).contentRating
    ).toBeDefined();
  });
});

/**
 * 🔴 CALL-SITE COVERAGE for the two `<Select>` option lists.
 *
 * These two consts are the DATA both the standalone submit wizard
 * (`ExternalSubmitForm`) and the listing edit form (`ExternalListingEditForm`)
 * hand to Mantine, so pinning them here guards both surfaces without rendering
 * either — and it guards the WIRING, not the label maps. A mutant that points
 * either const back at its old re-derivation (`c.charAt(0).toUpperCase() +
 * c.slice(1)` / `r.toUpperCase()`) leaves both label maps intact and every
 * helper unit test green; only these assertions move.
 *
 * The `value` half is asserted alongside the `label` half deliberately: the
 * whole failure mode being guarded is a surface that shows the stored key, so a
 * test that only looked at labels could not tell a correct option list from one
 * that had silently swapped the two halves.
 */
describe('🔴 the Select option lists render LABELS, never the stored key', () => {
  it('category options pair each stored value with its display label', () => {
    expect(OFFSITE_CATEGORY_OPTIONS).toEqual([
      { value: 'generation', label: 'Generation' },
      { value: 'games', label: 'Games' },
      { value: 'utility', label: 'Utility' },
      { value: 'discovery', label: 'Discovery' },
      { value: 'moderation', label: 'Moderation' },
      { value: 'analytics', label: 'Analytics' },
      { value: 'other', label: 'Other' },
    ]);
  });

  /**
   * 🔴 `pg13` is the discriminating rung and the reason this assertion is not a
   * loop: its label `PG-13` is the one value no transformation of the key
   * produces, so it separates the shared map from BOTH near-miss re-derivations
   * — the `PG13` this const used to ship, and the `Pg13` a title-case would give.
   */
  it('rating options pair each stored value with its display label', () => {
    expect(OFFSITE_CONTENT_RATING_OPTIONS).toEqual([
      { value: 'g', label: 'G' },
      { value: 'pg', label: 'PG' },
      { value: 'pg13', label: 'PG-13' },
      { value: 'r', label: 'R' },
      { value: 'x', label: 'X' },
    ]);
  });

  it('no option anywhere renders its own stored key as the label', () => {
    for (const o of [...OFFSITE_CATEGORY_OPTIONS, ...OFFSITE_CONTENT_RATING_OPTIONS]) {
      expect(o.label).not.toBe(o.value);
    }
  });
});
