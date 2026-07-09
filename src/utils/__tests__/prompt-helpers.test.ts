import { describe, it, expect } from 'vitest';
import { parsePromptSnippetReferences, WILDCARD_CATEGORY_NAME } from '~/utils/prompt-helpers';

describe('parsePromptSnippetReferences', () => {
  it('parses a simple #name reference', () => {
    const refs = parsePromptSnippetReferences('a cat, #character, masterpiece');
    expect(refs.map((r) => r.category)).toEqual(['character']);
  });

  it('parses path-style names with / . -', () => {
    const refs = parsePromptSnippetReferences('#BoChars/female/modern and #foo.bar-baz');
    expect(refs.map((r) => r.category)).toEqual(['BoChars/female/modern', 'foo.bar-baz']);
  });

  it('parses DIGIT-leading names (regression: #80s was previously unreferenceable)', () => {
    // A category named `80s/80s_locations_combined` is importable (filename-based), so the ref
    // parser must accept a leading digit. Before the fix the leading `[a-zA-Z]` requirement made
    // this match nothing, so snippet expansion silently never fired and the snippets were stripped
    // from the persisted workflow metadata.
    const refs = parsePromptSnippetReferences('motorcycle, synthwave, #80s/80s_locations_combined');
    expect(refs.map((r) => r.category)).toEqual(['80s/80s_locations_combined']);
  });

  it('returns each occurrence in document order (no dedup — slot counting)', () => {
    const refs = parsePromptSnippetReferences('#character fights #character');
    expect(refs.map((r) => r.category)).toEqual(['character', 'character']);
    expect(refs[0].start).toBeLessThan(refs[1].start);
  });

  it('does not capture a leading separator', () => {
    // `_`, `.`, `/`, `-` may not start a name (avoids `__…__` delimiter ambiguity at import).
    const refs = parsePromptSnippetReferences('#-foo #/bar #_baz');
    expect(refs.map((r) => r.category)).toEqual([]);
  });

  it('WILDCARD_CATEGORY_NAME stays in sync (anchored) — accepts digit-leading, rejects sep-leading', () => {
    const rx = new RegExp(`^${WILDCARD_CATEGORY_NAME}$`);
    expect(rx.test('80s')).toBe(true);
    expect(rx.test('character/female')).toBe(true);
    expect(rx.test('a_b.c-d/e')).toBe(true);
    expect(rx.test('/leading-slash')).toBe(false);
    expect(rx.test('_leading-underscore')).toBe(false);
  });
});
