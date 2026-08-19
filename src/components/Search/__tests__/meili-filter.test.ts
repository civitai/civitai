import { describe, expect, it } from 'vitest';
import { quoteMeiliValue } from '~/components/Search/meili-filter';

describe('quoteMeiliValue', () => {
  it('quotes an ordinary username without altering it', () => {
    expect(quoteMeiliValue('manuelurenah')).toBe("'manuelurenah'");
  });

  it('quotes whitespace', () => {
    expect(quoteMeiliValue('Rogue Light')).toBe("'Rogue Light'");
  });

  it('escapes a single quote', () => {
    expect(quoteMeiliValue("O'Brien")).toBe("'O\\'Brien'");
  });

  it('escapes a backslash', () => {
    expect(quoteMeiliValue('a\\b')).toBe("'a\\\\b'");
  });

  it('escapes the backslash before the quote it precedes', () => {
    expect(quoteMeiliValue("a\\'b")).toBe("'a\\\\\\'b'");
  });

  it('quotes a reserved word so it is read as a value', () => {
    expect(quoteMeiliValue('NOT')).toBe("'NOT'");
    expect(quoteMeiliValue('EXISTS')).toBe("'EXISTS'");
  });

  it('quotes expression punctuation', () => {
    expect(quoteMeiliValue('ab)cd')).toBe("'ab)cd'");
    expect(quoteMeiliValue('ab"cd')).toBe("'ab\"cd'");
    expect(quoteMeiliValue('a,b:c;d')).toBe("'a,b:c;d'");
  });

  it('quotes non-ASCII values', () => {
    expect(quoteMeiliValue('🙂emoji')).toBe("'🙂emoji'");
    expect(quoteMeiliValue('é中')).toBe("'é中'");
  });

  it('builds the filter expression the images search page sends', () => {
    expect(`poi != true OR user.username = ${quoteMeiliValue("Rogue O'Light")}`).toBe(
      "poi != true OR user.username = 'Rogue O\\'Light'"
    );
  });
});
