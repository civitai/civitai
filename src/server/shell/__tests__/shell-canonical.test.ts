import { describe, expect, it } from 'vitest';
import {
  isCanonicalShellPath,
  SHELL_ORIGINAL_URL_HEADER,
  shellBounceLocation,
  shellOriginalUrl,
} from '~/server/shell/shell-canonical';

/**
 * The original-URL header a canonical shell request carries, and where a declined one is sent.
 * The bounce's Location is built from a request header, so every value that is not exactly an
 * image path plus a query must land on the fallback — never on another path, host or scheme.
 */

const bounce = (value?: string | string[]) =>
  shellBounceLocation('images', {
    headers: value === undefined ? {} : { [SHELL_ORIGINAL_URL_HEADER]: value },
  } as never);

describe('shellOriginalUrl', () => {
  it.each([
    '/images/1',
    '/images/123456789',
    '/images/123?postId=5',
    '/images/123?postId=5&collectionId=9',
    '/images/123?',
    '/images/123?q=a%20b&x=%2F%2Fevil.example',
  ])('accepts %s', (value) => {
    expect(shellOriginalUrl('images', value)).toBe(value);
  });

  it.each<[string, string | string[] | undefined]>([
    ['missing', undefined],
    ['empty', ''],
    ['a repeated header', ['/images/1', '/images/2']],
    ['an absolute URL', 'https://evil.example/images/1'],
    ['a protocol-relative URL', '//evil.example/images/1'],
    ['a double slash in the path', '//images/1'],
    ['a backslash', '/\\evil.example/images/1'],
    ['a backslash in the path', '/images\\1'],
    ['another path', '/models/1'],
    ['the canonical path itself', '/images/shell'],
    ['the route home', '/images'],
    ['a non-numeric id', '/images/abc'],
    ['an id with a suffix', '/images/1abc'],
    ['a trailing slash', '/images/1/'],
    ['a sub-path', '/images/1/edit'],
    ['a dot segment', '/images/../moderator'],
    ['an encoded slash', '/images/1%2F..%2F..%2Fmoderator'],
    ['an encoded id', '/images/%31'],
    ['a negative id', '/images/-1'],
    ['an over-long id', `/images/${'1'.repeat(17)}`],
    ['no leading slash', 'images/1'],
    ['a fragment', '/images/1#x'],
    ['a fragment in the query', '/images/1?a=1#x'],
    ['CR/LF in the path', '/images/1\r\nLocation: https://evil.example'],
    ['CR/LF in the query', '/images/1?a=1\r\nSet-Cookie: x=1'],
    ['a space in the query', '/images/1?a=b c'],
    ['a tab in the query', '/images/1?a=b\tc'],
    ['a non-ASCII character', '/images/1?a=é'],
    ['a NUL byte', '/images/1?a=\0'],
    ['leading whitespace', ' /images/1'],
    ['an over-long value', `/images/1?a=${'x'.repeat(2048)}`],
  ])('rejects %s, and the bounce goes to /images', (_, value) => {
    expect(shellOriginalUrl('images', value)).toBeNull();
    expect(bounce(value)).toBe('/images');
  });
});

describe('shellBounceLocation', () => {
  it.each([
    ['/images/123', '/images/123?civ-shell=0'],
    ['/images/123?', '/images/123?civ-shell=0'],
    ['/images/123?postId=5', '/images/123?postId=5&civ-shell=0'],
    ['/images/123?postId=5&collectionId=9', '/images/123?postId=5&collectionId=9&civ-shell=0'],
    // Another value of the bypass is replaced, never kept alongside it.
    ['/images/123?civ-shell=1&postId=5', '/images/123?civ-shell=0&postId=5'],
    // The query is re-serialised: only percent-encoded text reaches the Location.
    ['/images/123?q=a\\b', '/images/123?q=a%5Cb&civ-shell=0'],
  ])('sends %s back as %s', (value, location) => {
    expect(bounce(value)).toBe(location);
  });

  it('sends a request with no original URL to /images', () => {
    expect(bounce()).toBe('/images');
  });
});

describe('isCanonicalShellPath', () => {
  it.each([
    ['/images/shell', true],
    ['/images/shell?civ-shell=0', true],
    ['/images/123', false],
    ['/images/shell/', false],
    ['/images/shells', false],
    ['/_next/data/build/images/shell.json', false],
  ])('%s → %s', (url, expected) => {
    expect(isCanonicalShellPath('images', url)).toBe(expected);
  });
});
