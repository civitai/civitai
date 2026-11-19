import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { holdsUploadKeyText } from '@civitai/db-queries/profile-picture-clear';
import { assertNoUnfinishedUploads, keysIn } from '~/server/services/image-url-ownership';

/**
 * `holdsUploadKeyText` is the SQL rule for "this `User.image` holds an upload key", and the profile
 * save refuses any value `keysIn` finds a key in. Whatever the SQL rule refuses, the save must
 * already refuse, so no value the save writes can trip it. The SQL rule reads fewer forms than
 * `keysIn`; those forms are pinned below as known gaps, held by the save alone.
 */
const KEY = '3f6e2a10-9b4c-4d7e-8a21-6c0b5d9e1f42';

let pg: PGlite;
beforeAll(() => {
  pg = new PGlite();
});
afterAll(() => pg.close());

const sqlFinds = async (value: string) =>
  (await pg.query<{ found: boolean }>(`SELECT ${holdsUploadKeyText('$1::text')} AS found`, [value]))
    .rows[0].found;

const BOTH = [
  ['a bare key', KEY],
  ['an upper-case key', KEY.toUpperCase()],
  ['a CDN url around a key', `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${KEY}/width=96`],
  ['an encoded dash', KEY.replace(/-/g, '%2D')],
  ['an encoded dash, lower case', KEY.replace(/-/g, '%2d')],
];
const NEITHER = [
  ['an OAuth avatar url', 'https://avatars.githubusercontent.com/u/1?v=4'],
  ['a Discord avatar url', 'https://cdn.discordapp.com/avatars/123456789/a1b2c3d4e5f6.png'],
  ['a Google avatar url', 'https://lh3.googleusercontent.com/a/ACg8ocJ_x-Yz'],
  ['a legacy file name', 'legacy-avatar.jpeg'],
  ['a key one hex digit short', KEY.slice(0, -1)],
];
const GAPS = [
  ['a letter percent-encoded', KEY.replace('a', '%61')],
  ['a double-encoded dash', KEY.replace(/-/g, '%252d')],
  ['a tab inside the key', KEY.slice(0, 4) + '\t' + KEY.slice(4)],
];

describe('the SQL key rule against the profile save', () => {
  it.each(BOTH)('🔴 both find a key in %s', async (_form, value) => {
    expect(keysIn(value)).toEqual([KEY]);
    expect(await sqlFinds(value)).toBe(true);
  });

  it.each(NEITHER)('neither finds a key in %s (control)', async (_form, value) => {
    expect(keysIn(value)).toEqual([]);
    expect(await sqlFinds(value)).toBe(false);
  });

  it.each(GAPS)('known gap: only the save finds the key in %s', async (_form, value) => {
    expect(keysIn(value)).toEqual([KEY]);
    expect(await sqlFinds(value)).toBe(false);
  });

  it('a non-http url with a key: keysIn reads none, and the save refuses it before keysIn', async () => {
    const value = `blob:https://civitai.com/${KEY}`;
    expect(await sqlFinds(value)).toBe(true);
    expect(keysIn(value)).toEqual([]);
    expect(() => assertNoUnfinishedUploads([value])).toThrow();
  });
});
