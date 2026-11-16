import { describe, expect, it } from 'vitest';
import { outputUnlockRedHref } from '~/components/AppBlocks/outputUnlockLinkOut';

/**
 * The output unlock's link-out: the same app on civitai.red at the current sub-path. Every
 * expected value is a literal, so the test cannot agree with a wrong builder by construction.
 */
const href = (subPath: string, slug = 'live-characters') =>
  outputUnlockRedHref({ redDomain: 'civitai.red', slug, subPath });

describe('outputUnlockRedHref', () => {
  it('the app root when there is no sub-path', () => {
    expect(href('')).toBe('https://civitai.red/apps/run/live-characters');
  });

  it('the current sub-path, segment by segment', () => {
    expect(href('clips/42')).toBe('https://civitai.red/apps/run/live-characters/clips/42');
  });

  it('🔴 `..` and `.` cannot climb out of the app', () => {
    expect(href('../../admin')).toBe('https://civitai.red/apps/run/live-characters/admin');
    expect(href('clips/../../../x/./y')).toBe(
      'https://civitai.red/apps/run/live-characters/clips/x/y'
    );
  });

  it('🔴 `//` cannot introduce another host or an empty segment', () => {
    expect(href('//evil.example/x')).toBe(
      'https://civitai.red/apps/run/live-characters/evil.example/x'
    );
    expect(href('a//b')).toBe('https://civitai.red/apps/run/live-characters/a/b');
  });

  it('a query, a fragment or a space in a segment is encoded, never carried', () => {
    expect(href('a b?sl=1#top')).toBe(
      'https://civitai.red/apps/run/live-characters/a%20b%3Fsl%3D1%23top'
    );
  });

  it('the slug is encoded too', () => {
    expect(href('', 'x/../y')).toBe('https://civitai.red/apps/run/x%2F..%2Fy');
  });
});
