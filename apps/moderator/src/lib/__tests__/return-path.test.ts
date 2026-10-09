import { describe, expect, it } from 'vitest';
import { safeReturnPath } from '../return-path';

/** `?denied=` comes from a URL anyone can edit; only a path on this app may come back out. */

describe('safeReturnPath', () => {
  it('keeps a same-app path, with its query and fragment', () => {
    expect(safeReturnPath('/decisions/support/g_1?version=v0.1#members')).toBe(
      '/decisions/support/g_1?version=v0.1#members'
    );
    expect(safeReturnPath('/')).toBe('/');
  });

  it.each([
    ['protocol-relative', '//evil.example/x'],
    ['absolute https', 'https://evil.example/x'],
    ['absolute http', 'http://evil.example'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<b>x</b>'],
    ['backslash host', '/\\evil.example'],
    ['backslash anywhere', '/a\\b'],
    ['tab that a browser strips into //', '/\t/evil.example'],
    ['newline', '/a\nb'],
    ['relative, no leading slash', 'decisions'],
    ['empty', ''],
    ['too long', `/${'a'.repeat(2048)}`],
    ['dot segment collapsing to //', '/.//evil.example/decisions'],
    ['parent segment collapsing to //', '/a/..//evil.example/decisions'],
    ['encoded dot segment collapsing to //', '/%2e//evil.example/decisions'],
  ])('refuses %s', (_name, raw) => {
    expect(safeReturnPath(raw)).toBeNull();
  });

  it('refuses null and undefined', () => {
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
  });

  it('keeps a path exactly at the length cap', () => {
    const atCap = `/${'a'.repeat(2047)}`;
    expect(safeReturnPath(atCap)).toBe(atCap);
  });

  it('normalises dot segments without leaving the app', () => {
    expect(safeReturnPath('/a/../../b')).toBe('/b');
  });
});
