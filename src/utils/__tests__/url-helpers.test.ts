import { describe, expect, it } from 'vitest';

import { safeInternalPath, safeSameOriginPath } from '~/utils/url-helpers';
import {
  SAFE_RETURN_PATHS,
  UNSAFE_RETURN_PATHS,
} from '../../../packages/civitai-auth/src/__tests__/return-path-cases';

const FALLBACK = '/posts/1';
const ORIGIN = 'https://civitai.example';

describe('safeInternalPath', () => {
  it('keeps a same-origin path, query and hash included', () => {
    expect(safeInternalPath('/user/alice/posts?section=draft', FALLBACK)).toBe(
      '/user/alice/posts?section=draft'
    );
    expect(safeInternalPath('/user/account#accounts', FALLBACK)).toBe('/user/account#accounts');
  });

  it('collapses an absolute url to the fallback', () => {
    expect(safeInternalPath('https://other.example/x', FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath('//other.example/x', FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath('/\\other.example/x', FALLBACK)).toBe(FALLBACK);
  });

  it('collapses anything that is not a path-shaped string', () => {
    expect(safeInternalPath('other.example', FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath('', FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath(undefined, FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath(null, FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath(42, FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath(['/ok'], FALLBACK)).toBe(FALLBACK);
  });

  it.each(UNSAFE_RETURN_PATHS)('falls back for: %s', (_name, raw) => {
    expect(safeInternalPath(raw, FALLBACK)).toBe(FALLBACK);
  });

  it.each(SAFE_RETURN_PATHS)('keeps: %s', (_name, raw, expected) => {
    expect(safeInternalPath(raw, FALLBACK)).toBe(expected);
  });
});

describe('safeSameOriginPath', () => {
  it.each(UNSAFE_RETURN_PATHS)('falls back for: %s', (_name, raw) => {
    expect(safeSameOriginPath(raw, ORIGIN, FALLBACK)).toBe(FALLBACK);
  });

  it.each(SAFE_RETURN_PATHS)('keeps: %s', (_name, raw, expected) => {
    expect(safeSameOriginPath(raw, ORIGIN, FALLBACK)).toBe(expected);
  });

  it('reduces an absolute url on the origin to its path', () => {
    expect(safeSameOriginPath(`${ORIGIN}/a/b?c=1#d`, ORIGIN, FALLBACK)).toBe('/a/b?c=1#d');
  });

  it('rejects an absolute url on the origin whose normalised path is not same-origin', () => {
    expect(safeSameOriginPath(`${ORIGIN}/.//other.example`, ORIGIN, FALLBACK)).toBe(FALLBACK);
    expect(safeSameOriginPath(`${ORIGIN}/a/..//other.example`, ORIGIN, FALLBACK)).toBe(FALLBACK);
  });

  it.each([
    ['backslash after the origin', `${ORIGIN}/\\other.example`],
    ['tab after the origin', `${ORIGIN}/\t/other.example`],
    ['line feed after the origin', `${ORIGIN}/\n/other.example`],
  ])('rejects an absolute url on the origin with a %s', (_name, raw) => {
    expect(safeSameOriginPath(raw, ORIGIN, FALLBACK)).toBe(FALLBACK);
  });

  it.each([
    ['different host', 'https://other.example/a'],
    ['different scheme', 'http://civitai.example/a'],
    ['different port', 'https://civitai.example:8443/a'],
    ['userinfo that names the origin', 'https://civitai.example@other.example/a'],
    ['non-http scheme', 'javascript:alert(1)'],
  ])('rejects an absolute url with a %s', (_name, raw) => {
    expect(safeSameOriginPath(raw, ORIGIN, FALLBACK)).toBe(FALLBACK);
  });

  it('falls back for non-strings', () => {
    expect(safeSameOriginPath(undefined, ORIGIN, FALLBACK)).toBe(FALLBACK);
    expect(safeSameOriginPath(['/ok'], ORIGIN, FALLBACK)).toBe(FALLBACK);
  });
});
