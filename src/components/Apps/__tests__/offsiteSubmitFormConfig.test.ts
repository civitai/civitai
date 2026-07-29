import { describe, expect, it } from 'vitest';
import {
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
    expect(validateOffsiteSubmitForm({ ...valid, externalUrl: 'http://x.com' }).externalUrl).toBeDefined();
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
    expect(validateOffsiteSubmitForm({ ...valid, name: 'a'.repeat(OFFSITE_NAME_MAX + 1) }).name).toBeDefined();
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
    expect(validateOffsiteSubmitForm({ ...valid, contentRating: 'xxx' as any }).contentRating).toBeDefined();
  });
});
