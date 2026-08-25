import { describe, expect, test } from 'vitest';
import { appListingDescriptionToPlainText } from '~/components/Apps/appListingDescription';
import { APP_LISTING_DESCRIPTION_ALLOWED_ELEMENTS } from '~/components/Apps/AppListingDescription';

/**
 * The plain-text projection half of the app-listing description rule.
 *
 * Every test here was watched RED against `origin/main` (where neither module
 * existed — the suite failed to import) and green at HEAD. The RED there is
 * "module not found", which is weak evidence on its own, so the mutation table
 * in the PR body is what actually establishes that each assertion can fail for
 * its OWN reason against a present-but-wrong implementation.
 */
describe('appListingDescriptionToPlainText', () => {
  // ── the backtick case: the reason this function exists ──────────────────────
  //
  // Twelve first-party listings shipped descriptions using backticks for literal
  // syntax. On the markdown surface those became code spans; on the card and in
  // og:description they were literal backtick characters.
  test('🔴 strips inline-code backticks and keeps their content', () => {
    expect(appListingDescriptionToPlainText('Use `{style}` and `#tag` in `.txt`')).toBe(
      'Use {style} and #tag in .txt'
    );
  });

  test('🔴 strips emphasis markers and keeps their content', () => {
    expect(appListingDescriptionToPlainText('a **bold** and _italic_ word')).toBe(
      'a bold and italic word'
    );
  });

  test('🔴 keeps link TEXT and drops the URL syntax', () => {
    expect(appListingDescriptionToPlainText('see [the docs](https://example.com/x) now')).toBe(
      'see the docs now'
    );
  });

  test('🔴 drops heading hashes and keeps the heading text', () => {
    expect(appListingDescriptionToPlainText('# Title\n\nBody text.')).toBe('Title Body text.');
  });

  // ── the hard-wrap case: `prompt-vault` wraps at ~76 columns ─────────────────
  //
  // Those wraps were literal under `pre-wrap` and collapsed under markdown. The
  // teaser/meta projection collapses them, which is right for a single line.
  test('🔴 collapses hard line wraps into single spaces', () => {
    const wrapped = 'A description that the author\nhard-wrapped at a fixed\ncolumn width.';
    expect(appListingDescriptionToPlainText(wrapped)).toBe(
      'A description that the author hard-wrapped at a fixed column width.'
    );
  });

  test('🔴 separates block elements rather than concatenating their text', () => {
    // Without a separator this reads "onetwo" — a wrong word, not just wrong
    // spacing. Distinct fixture words so the assertion cannot pass by accident.
    expect(appListingDescriptionToPlainText('one\n\ntwo')).toBe('one two');
  });

  test('🔴 separates list items rather than concatenating them', () => {
    expect(appListingDescriptionToPlainText('- alpha\n- beta\n- gamma')).toBe('alpha beta gamma');
  });

  test('keeps fenced code CONTENT, without the fence', () => {
    expect(appListingDescriptionToPlainText('```\nnpm install\n```')).toBe('npm install');
  });

  test('substitutes an image with its alt text', () => {
    // `img` is not renderable on any surface this function feeds, and it is not
    // in the markdown allowlist either — alt text is the honest stand-in.
    expect(appListingDescriptionToPlainText('before ![a diagram](https://x/y.png) after')).toBe(
      'before a diagram after'
    );
  });

  // ── the metadata safety property ───────────────────────────────────────────
  test('🔴 never emits markup, so it is safe for <meta content=…>', () => {
    const hostile = '[x](https://e.com) **b** `c` ![i](https://e.com/p.png)';
    const out = appListingDescriptionToPlainText(hostile);
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).toBe('x b c i');
  });

  test('passes literal angle brackets through as TEXT without constructing markup', () => {
    // A positive control for the assertion above: prove the `not.toContain('<')`
    // check is not vacuous by showing the function CAN carry a `<` when the
    // author typed one — what it must never do is CREATE one. Without this, a
    // function that returned '' would satisfy every no-markup assertion.
    expect(appListingDescriptionToPlainText('a < b and c > d')).toBe('a < b and c > d');
  });

  test('is total — empty and whitespace-only input return an empty string', () => {
    expect(appListingDescriptionToPlainText('')).toBe('');
    expect(appListingDescriptionToPlainText('   \n\n  ')).toBe('');
  });

  test('leaves plain prose byte-identical', () => {
    expect(appListingDescriptionToPlainText('Just a normal sentence.')).toBe(
      'Just a normal sentence.'
    );
  });
});

/**
 * The markdown allowlist half of the rule.
 *
 * 🔴 These assert the CONTENT of the exported allowlist, which is what the
 * renderer actually passes to `CustomMarkdown`. A test that only asserted the
 * array is non-empty would pass with `img` in it.
 */
describe('APP_LISTING_DESCRIPTION_ALLOWED_ELEMENTS', () => {
  test('🔴 excludes `img` — a description must not embed a remote image', () => {
    // The listing has a mod-reviewed screenshot gallery for imagery; the
    // description is text. Adding `img` here re-opens author-controlled remote
    // resource loading on three surfaces at once.
    expect(APP_LISTING_DESCRIPTION_ALLOWED_ELEMENTS).not.toContain('img');
  });

  test('🔴 excludes `iframe`', () => {
    expect(APP_LISTING_DESCRIPTION_ALLOWED_ELEMENTS).not.toContain('iframe');
  });

  test('🔴 includes `code` — literal syntax is the format authors actually use', () => {
    expect(APP_LISTING_DESCRIPTION_ALLOWED_ELEMENTS).toContain('code');
  });

  test('includes the text and structure elements a description needs', () => {
    // Named explicitly: dropping `p` silently blanks every description, and that
    // is not something a "list is non-empty" check would catch.
    for (const el of ['p', 'br', 'strong', 'em', 'a', 'pre', 'ul', 'ol', 'li', 'blockquote']) {
      expect(APP_LISTING_DESCRIPTION_ALLOWED_ELEMENTS).toContain(el);
    }
  });

  test('is a non-empty allowlist, not an accidental empty array', () => {
    // An empty array is NOT the same as `undefined` in react-markdown: undefined
    // permits everything, [] permits nothing. Both are wrong here, and this
    // pins the difference.
    expect(APP_LISTING_DESCRIPTION_ALLOWED_ELEMENTS.length).toBeGreaterThan(5);
  });
});
