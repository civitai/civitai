import { describe, expect, it } from 'vitest';
import type { AppPostIntentRecord } from '~/server/services/post-intent/post-intent.logic';
import {
  canonicalManifestUrl,
  checkManifest,
  isUnderAppPrefix,
  matchAppRecord,
  sniffIntentMedia,
} from '~/server/services/post-intent/post-intent.logic';

const record: AppPostIntentRecord = {
  listingId: 'apl_games',
  listingName: 'Civitai Games',
  appId: 'game-frame-client',
  host: 'games.civitai.com',
  pathPrefix: '/api/share/',
};

const manifest = (over: Record<string, unknown> = {}) => ({
  app: 'game-frame-client',
  media: [{ url: 'https://games.civitai.com/api/share/sh_1/reel.mp4' }],
  title: 'Pictionary',
  returnUrl: 'https://games.civitai.com/?reel=A',
  link: 'https://games.civitai.com/?game=pictionary',
  ...over,
});

const now = new Date('2026-10-26T00:00:00Z');

describe('isUnderAppPrefix', () => {
  it('accepts a file under the recorded host and prefix', () => {
    expect(isUnderAppPrefix('https://games.civitai.com/api/share/sh_1.json', record)).toBe(true);
  });

  it.each([
    ['another host', 'https://evil.example/api/share/sh_1.json'],
    ['a sibling subdomain', 'https://uploads.games.civitai.com/api/share/sh_1.json'],
    ['a path outside the prefix', 'https://games.civitai.com/uploads/sh_1.json'],
    ['a dot-segment escape', 'https://games.civitai.com/api/share/../uploads/sh_1.json'],
    ['an encoded dot-segment escape', 'https://games.civitai.com/api/share/%2e%2e/uploads/x.json'],
    ['an encoded slash', 'https://games.civitai.com/api/share/..%2fuploads/x.json'],
    ['a prefix without the trailing slash', 'https://games.civitai.com/api/shared/x.json'],
    ['the bare prefix', 'https://games.civitai.com/api/share/'],
    ['plain http', 'http://games.civitai.com/api/share/sh_1.json'],
    ['a non-standard port', 'https://games.civitai.com:8443/api/share/sh_1.json'],
    ['credentials', 'https://user:pw@games.civitai.com/api/share/sh_1.json'],
    ['garbage', 'not a url'],
  ])('refuses %s', (_label, url) => {
    expect(isUnderAppPrefix(url, record)).toBe(false);
  });
});

describe('matchAppRecord', () => {
  it('finds no record for a host nobody approved', () => {
    expect(matchAppRecord('https://evil.example/api/share/a.json', [record])).toBeNull();
  });
});

describe('checkManifest', () => {
  it('accepts a manifest whose app agrees with the record', () => {
    expect(checkManifest(manifest(), record, now).title).toBe('Pictionary');
  });

  it('refuses a manifest naming a different app than the one recorded for its host', () => {
    expect(() => checkManifest(manifest({ app: 'some-other-client' }), record, now)).toThrow(
      expect.objectContaining({ code: 'app-mismatch' })
    );
  });

  it('refuses media outside the prefix', () => {
    const json = manifest({ media: [{ url: 'https://games.civitai.com/uploads/a.png' }] });
    expect(() => checkManifest(json, record, now)).toThrow(
      expect.objectContaining({ code: 'outside-prefix' })
    );
  });

  it('refuses a returnUrl on another host', () => {
    expect(() =>
      checkManifest(manifest({ returnUrl: 'https://evil.example/' }), record, now)
    ).toThrow(expect.objectContaining({ code: 'bad-manifest' }));
  });

  it('refuses an expired manifest', () => {
    expect(() =>
      checkManifest(manifest({ expiresAt: '2026-10-25T00:00:00Z' }), record, now)
    ).toThrow(expect.objectContaining({ code: 'expired' }));
  });

  it('refuses more than 10 media items', () => {
    const media = Array.from({ length: 11 }, (_, i) => ({
      url: `https://games.civitai.com/api/share/${i}.png`,
    }));
    expect(() => checkManifest(manifest({ media }), record, now)).toThrow(
      expect.objectContaining({ code: 'bad-manifest' })
    );
  });

  it('keeps a catalog item key', () => {
    expect(checkManifest(manifest({ item: 'fakeful' }), record, now).item).toBe('fakeful');
  });

  it.each([
    ['a path', '../fakeful'],
    ['a query', 'fakeful?x=1'],
    ['an over-long key', 'a'.repeat(65)],
    ['an empty key', ''],
    ['a number', 42],
    ['an object', { id: 'fakeful' }],
  ])('drops %s instead of refusing the share', (_, item) => {
    const checked = checkManifest(manifest({ item }), record, now);
    expect(checked.item).toBeUndefined();
    expect(checked.title).toBe('Pictionary');
  });
});

describe('sniffIntentMedia', () => {
  const bytes = (...b: number[]) => Uint8Array.from([...b, ...new Array(16).fill(0)]);

  it.each([
    ['jpeg', bytes(0xff, 0xd8, 0xff), 'image/jpeg'],
    ['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'image/png'],
    ['mp4', bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70), 'video/mp4'],
    ['webm', bytes(0x1a, 0x45, 0xdf, 0xa3), 'video/webm'],
  ])('reads %s from the bytes', (_label, b, mimeType) => {
    expect(sniffIntentMedia(b)?.mimeType).toBe(mimeType);
  });

  it('does not take a HEIC still for an MP4 video', () => {
    expect(sniffIntentMedia(bytes(0, 0, 0, 0x18, ...Buffer.from('ftypheic')))).toBeNull();
  });

  it('refuses html served under an image name', () => {
    expect(sniffIntentMedia(new TextEncoder().encode('<!doctype html><html></html>'))).toBeNull();
  });
});

describe('canonicalManifestUrl', () => {
  const canonical = 'https://games.civitai.com/api/share/sh_1.json';
  it.each([
    canonical,
    `${canonical}#again`,
    'https://GAMES.Civitai.com/api/share/sh_1.json',
    'https://games.civitai.com:443/api/share/sh_1.json',
  ])('maps %s to one key', (raw) => {
    expect(canonicalManifestUrl(raw)).toBe(canonical);
  });

  it.each([
    `${canonical}?a=1`,
    'https://games.civitai.com/api/share/sh%5F1.json',
    'https://games.civitai.com/api/share/%25.json',
  ])('refuses %s', (raw) => {
    expect(canonicalManifestUrl(raw)).toBeNull();
  });
});
