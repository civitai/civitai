import { describe, expect, it } from 'vitest';
import {
  deriveListingFromUrl,
  emptyOffsiteSubmitForm,
  isDetailsStepComplete,
  isUrlStepComplete,
  type OffsiteSubmitFormValues,
} from '../offsiteSubmitFormConfig';
import { SLUG_REGEX } from '~/server/schema/blocks/publish-request.schema';

/**
 * W13 — External-link submit WIZARD. Pins the pure Step-1→Step-2 prefill
 * derivation (`deriveListingFromUrl`) and the wizard step-gating helpers so the
 * casing/slug rules and the reachable-step logic can't drift and are testable
 * without mounting the form.
 */

describe('deriveListingFromUrl — happy paths', () => {
  it('vitrine.civitai.com → Vitrine / vitrine', () => {
    expect(deriveListingFromUrl('https://vitrine.civitai.com')).toEqual({
      name: 'Vitrine',
      slug: 'vitrine',
    });
  });

  it('strips a leading www. and keeps the first label (hyphenated)', () => {
    // hostname is lower-cased by the URL parser, so the title-case is deterministic.
    expect(deriveListingFromUrl('https://www.My-App.io/path?q=1')).toEqual({
      name: 'My-App',
      slug: 'my-app',
    });
  });

  it('bare host → Example / example', () => {
    expect(deriveListingFromUrl('https://example.com')).toEqual({
      name: 'Example',
      slug: 'example',
    });
  });

  it('uses only the FIRST dot-label (subdomain wins over apex)', () => {
    expect(deriveListingFromUrl('https://cool-tool.example.co.uk')).toEqual({
      name: 'Cool-Tool',
      slug: 'cool-tool',
    });
  });

  it('lower-cases the remainder of each hyphen word', () => {
    expect(deriveListingFromUrl('https://SUPER-APP.com')).toEqual({
      name: 'Super-App',
      slug: 'super-app',
    });
  });

  it('a deep path / query / port does not affect the derivation', () => {
    expect(deriveListingFromUrl('https://myapp.io:8443/a/b/c?x=1#frag')).toEqual({
      name: 'Myapp',
      slug: 'myapp',
    });
  });
});

describe('deriveListingFromUrl — invalid / no-prefill (never throws)', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['http (not https)', 'http://example.com'],
    ['ftp scheme', 'ftp://example.com'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['not a url', 'not a url'],
    ['relative', '/apps/submit'],
    ['scheme-only', 'https://'],
  ])('%s → { name: "", slug: "" }', (_label, input) => {
    expect(deriveListingFromUrl(input)).toEqual({ name: '', slug: '' });
  });
});

describe('deriveListingFromUrl — slug is always SLUG_REGEX-safe or empty', () => {
  it('single-char host can not satisfy SLUG_REGEX → slug empty, name still set', () => {
    // SLUG_REGEX requires >= 2 chars (leading letter + trailing alnum).
    expect(deriveListingFromUrl('https://x.com')).toEqual({ name: 'X', slug: '' });
  });

  it('any non-empty slug it returns passes SLUG_REGEX', () => {
    const inputs = [
      'https://vitrine.civitai.com',
      'https://www.My-App.io',
      'https://example.com',
      'https://a1-b2-c3.net',
      'https://123startsdigit.com',
    ];
    for (const input of inputs) {
      const { slug } = deriveListingFromUrl(input);
      if (slug.length > 0) expect(SLUG_REGEX.test(slug)).toBe(true);
    }
  });

  it('leading digits are dropped so the slug starts with a letter', () => {
    // host `9lives` → strip leading non-letter → `lives`
    expect(deriveListingFromUrl('https://9lives.com').slug).toBe('lives');
  });
});

describe('wizard step gating', () => {
  const withUrl = (externalUrl: string): OffsiteSubmitFormValues => ({
    ...emptyOffsiteSubmitForm(),
    externalUrl,
  });

  it('isUrlStepComplete follows the shared https validation', () => {
    expect(isUrlStepComplete(withUrl('https://example.com/app'))).toBe(true);
    expect(isUrlStepComplete(withUrl('http://example.com'))).toBe(false);
    expect(isUrlStepComplete(withUrl(''))).toBe(false);
  });

  it('isDetailsStepComplete requires a valid whole form (url + name + slug)', () => {
    // url alone is not enough — name + slug are still required/blank.
    expect(isDetailsStepComplete(withUrl('https://example.com/app'))).toBe(false);

    const full: OffsiteSubmitFormValues = {
      ...emptyOffsiteSubmitForm(),
      externalUrl: 'https://example.com/app',
      name: 'My External App',
      slug: 'my-external-app',
    };
    expect(isDetailsStepComplete(full)).toBe(true);

    // a bad slug fails the details gate even with a valid url + name.
    expect(isDetailsStepComplete({ ...full, slug: 'Bad Slug' })).toBe(false);
  });
});
