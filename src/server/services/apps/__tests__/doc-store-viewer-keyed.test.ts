import { describe, expect, it } from 'vitest';
import { deriveViewerKey } from '~/server/services/apps/doc-store-viewer-keyed';
import { DOC_STORE_BOUNDS } from '~/server/services/apps/doc-store.types';

/**
 * GOLDEN VECTORS for the viewer-keyed document key (docs/app-storage-generic-core.md, "Key
 * derivation"): the first 128 bits of HMAC-SHA256 over the length-prefixed tuple (app id,
 * namespace, collection, mode, parent or "", viewer user id), as lowercase unpadded RFC 4648
 * base32, behind `<parent>:` under `parent+viewer`.
 *
 * Every expected key below was computed OUTSIDE this codebase, by an independent Python
 * implementation (`hmac`, `struct.pack('>I', len)`, `base64.b32encode(...).rstrip('=').lower()`),
 * never by the function under test. A change to any byte of the derivation fails them: such a
 * change would orphan every stored viewer-keyed document from its `@me` route.
 */
const SECRET = 'golden-vector-secret-0123456789abcdef';
const PARENT = '01JD3Q8M5Z4X2V7K9C6B1N0RTA';
const V1 = 824_017;
const V2 = 824_024;
const base = {
  appId: 'apb_golden1',
  ns: 'prod',
  collection: 'votes',
  mode: 'parent+viewer' as const,
  parent: PARENT as string | null,
  viewerUid: V1,
};

describe('deriveViewerKey — golden vectors', () => {
  it.each([
    ['parent+viewer, viewer 1', base, `${PARENT}:ce4gzqzsrgjueh344vtna5vj5i`],
    [
      'the same parent, viewer 2',
      { ...base, viewerUid: V2 },
      `${PARENT}:xj76jyrqg4kqkvfnm2judvcv4a`,
    ],
    ['another parent', { ...base, parent: 'record-2' }, 'record-2:kqpkyku5hpqyiaade2n5lcqptu'],
    ['another namespace', { ...base, ns: 'dev:824017' }, `${PARENT}:ttnw2blq5h4bgisi63s7g6dbwu`],
    [
      'viewer mode',
      { ...base, collection: 'likes', mode: 'viewer' as const, parent: null },
      'jeame3z6mua2db3xzvj3k3l3ja',
    ],
    [
      'viewer mode, another app',
      { ...base, appId: 'apb_golden2', collection: 'likes', mode: 'viewer' as const, parent: null },
      '56rb6h33h7bvuwhvbz7hr7z7ce',
    ],
  ])('%s', (_label, tuple, expected) => {
    expect(deriveViewerKey(SECRET, tuple)).toBe(expected);
  });

  it('is length-prefixed: moving a character between two fields changes the key', () => {
    const viewer = { collection: 'likes', mode: 'viewer' as const, parent: null, viewerUid: 1 };
    expect(deriveViewerKey(SECRET, { ...viewer, appId: 'ab', ns: 'c' })).toBe(
      'pk5nfc6cebn4zlqn2p3wxnyidu'
    );
    expect(deriveViewerKey(SECRET, { ...viewer, appId: 'a', ns: 'bc' })).toBe(
      'xcd6zjzndnlcuf6vg4rj3zhmly'
    );
  });

  it('the longest parent makes a 123-character key inside the store key grammar', () => {
    const parent = `${'a.B-c_9'.repeat(13)}xxxxx`;
    expect(parent).toHaveLength(96);
    const key = deriveViewerKey(SECRET, { ...base, parent });
    expect(key).toBe(`${parent}:ph3ppkikssfy7yyhtyrmq33trm`);
    expect(key).toHaveLength(123);
    expect(DOC_STORE_BOUNDS.key.test(key)).toBe(true);
  });

  it('is keyed: another secret gives another key for the same tuple', () => {
    expect(deriveViewerKey(`${SECRET}-other`, base)).not.toBe(
      `${PARENT}:ce4gzqzsrgjueh344vtna5vj5i`
    );
  });
});
