import { describe, expect, it } from 'vitest';
import {
  createModelFileDownloadUrl,
  createSerializedFileDownloadUrl,
  toApiModelFile,
} from '~/server/common/model-helpers';

/**
 * The invariant, pinned at the one place that can violate it:
 *
 *   a `fileId` is emitted ONLY alongside the version that file belongs to.
 *
 * Both public v1 shapers splice CROSS-VERSION files into a version's file list
 * (`getVaeFiles` → `files.push(...vae)`), so "every file in this array belongs
 * to this version" is false. The download route resolves a pinned URL as
 * `findFirst({ id: fileId, modelVersionId })` — a pair that disagrees is a hard
 * 404 on a URL that resolved fine before pinning existed.
 *
 * Nothing is mocked here: the helper and the URL string it produces ARE the
 * contract. Values are pairwise distinct so a mutant that binds the wrong id
 * (or swaps the two version operands) cannot coincidentally emit the right URL.
 */

const HOST_VERSION_ID = 4242;
const LINKED_VAE_VERSION_ID = 9999;

const OWNED_FILE = {
  id: 21,
  modelVersionId: HOST_VERSION_ID,
  type: 'Model',
  metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
} as const;

// Exactly what getVaeFiles emits: a file selected off the LINKED version
// (its own id, its own modelVersionId) with `type` rewritten to 'VAE'.
const SPLICED_VAE_FILE = {
  id: 91,
  modelVersionId: LINKED_VAE_VERSION_ID,
  type: 'VAE',
  metadata: { format: 'SafeTensor', size: 'full', fp: 'fp32' },
} as const;

describe('createSerializedFileDownloadUrl — a fileId never pairs with a foreign version', () => {
  it('pins a file the host version OWNS', () => {
    const url = new URL(
      `https://x.test${createSerializedFileDownloadUrl({
        file: OWNED_FILE,
        hostVersionId: HOST_VERSION_ID,
        primary: false,
      })}`
    );
    expect(url.pathname).toBe('/api/download/models/4242');
    expect([...url.searchParams.keys()]).toEqual(['fileId']);
    expect(url.searchParams.get('fileId')).toBe('21');
  });

  it('pins the elected primary too (a bare, re-resolvable URL is what #3861 fixed)', () => {
    const url = new URL(
      `https://x.test${createSerializedFileDownloadUrl({
        file: OWNED_FILE,
        hostVersionId: HOST_VERSION_ID,
        primary: true,
      })}`
    );
    expect(url.search).toBe('?fileId=21');
  });

  it('does NOT pin a file spliced in from a LINKED version', () => {
    const path = createSerializedFileDownloadUrl({
      file: SPLICED_VAE_FILE,
      hostVersionId: HOST_VERSION_ID,
      primary: false,
    });
    const url = new URL(`https://x.test${path}`);
    // The 404 shape this guards against: fileId=91 on version 4242, a pair
    // `findFirst({ id: 91, modelVersionId: 4242 })` resolves to null.
    expect(url.searchParams.get('fileId')).toBeNull();
    // …and it must not silently redirect the download at the OTHER version
    // either: that would move access gating and download attribution.
    expect(url.pathname).toBe('/api/download/models/4242');
    expect(url.pathname).not.toBe(`/api/download/models/${LINKED_VAE_VERSION_ID}`);
  });

  it('falls back to EXACTLY the pre-pin discriminator URL for a spliced file', () => {
    // Byte-identical to what the endpoints emitted before pinning existed —
    // the download route's linked-component fallback keys off `type`.
    const expected = createModelFileDownloadUrl({
      versionId: HOST_VERSION_ID,
      type: SPLICED_VAE_FILE.type,
      meta: SPLICED_VAE_FILE.metadata,
      primary: false,
    });
    expect(
      createSerializedFileDownloadUrl({
        file: SPLICED_VAE_FILE,
        hostVersionId: HOST_VERSION_ID,
        primary: false,
      })
    ).toBe(expected);
    // Positive control: that fallback URL is not empty of discriminators, so
    // the equality above is not two blank strings agreeing.
    expect(new URL(`https://x.test${expected}`).searchParams.get('type')).toBe('VAE');
  });

  it.each([
    ['missing', {}],
    ['null', { modelVersionId: null }],
  ])('does NOT pin when modelVersionId is %s (cannot prove the pair)', (_label, extra) => {
    const url = new URL(
      `https://x.test${createSerializedFileDownloadUrl({
        file: { id: 77, type: 'Model', metadata: { format: 'GGUF' }, ...extra },
        hostVersionId: HOST_VERSION_ID,
        primary: false,
      })}`
    );
    expect(url.searchParams.get('fileId')).toBeNull();
    expect(url.pathname).toBe('/api/download/models/4242');
  });

  it('over a matrix of (file version, host version) pairs, a fileId appears IFF they match', () => {
    const versionIds = [4242, 9999, 1, 4243];
    let pinned = 0;
    for (const fileVersionId of versionIds) {
      for (const hostVersionId of versionIds) {
        const url = new URL(
          `https://x.test${createSerializedFileDownloadUrl({
            file: { id: 500 + fileVersionId, modelVersionId: fileVersionId, type: 'Model' },
            hostVersionId,
            primary: false,
          })}`
        );
        const fileId = url.searchParams.get('fileId');
        // The path segment is ALWAYS the host version — never the file's.
        expect(url.pathname).toBe(`/api/download/models/${hostVersionId}`);
        if (fileVersionId === hostVersionId) {
          expect(fileId, `${fileVersionId} vs ${hostVersionId}`).toBe(String(500 + fileVersionId));
          pinned++;
        } else {
          expect(fileId, `${fileVersionId} vs ${hostVersionId}`).toBeNull();
        }
      }
    }
    // Positive control: the matrix really did exercise both branches.
    expect(pinned).toBe(versionIds.length);
  });
});

/**
 * The other half of the invariant: the file has to still HAVE its owning
 * version id by the time the URL is built. `getModelsWithVersions` reduces every
 * file through `toApiModelFile` before handing it to its two public consumers,
 * and that reduction used to destructure `modelVersionId` away — which is what
 * made a spliced VAE file indistinguishable from a local one at the shaper.
 */
describe('toApiModelFile — the owning version id survives the reduction', () => {
  const row = {
    id: 91,
    modelVersionId: 9999,
    type: 'VAE',
    visibility: 'Public',
    sizeKB: 5555,
    metadata: {
      format: 'SafeTensor',
      size: 'full',
      fp: 'fp32',
      quantType: 'Q8_0',
      isRequired: true,
      // Not published on the v1 wire body — must be dropped.
      selectedEpochUrl: 's3://internal',
    },
  };

  it('keeps modelVersionId (a spliced file is only identifiable by it)', () => {
    expect(toApiModelFile({ ...row }).modelVersionId).toBe(9999);
  });

  it('passes every other non-metadata field through untouched', () => {
    const out = toApiModelFile({ ...row });
    expect(out.id).toBe(91);
    expect(out.type).toBe('VAE');
    expect(out.visibility).toBe('Public');
    expect(out.sizeKB).toBe(5555);
  });

  it('narrows metadata to exactly the five published fields', () => {
    const out = toApiModelFile({ ...row });
    expect(Object.keys(out.metadata).sort()).toEqual([
      'format',
      'fp',
      'isRequired',
      'quantType',
      'size',
    ]);
    expect(out.metadata.format).toBe('SafeTensor');
    expect(out.metadata.fp).toBe('fp32');
    expect(out.metadata.quantType).toBe('Q8_0');
    expect(out.metadata.isRequired).toBe(true);
  });

  it('tolerates a missing metadata blob', () => {
    // `metadata` is declared and not passed: the type argument is spelled out because
    // `{ metadata?: unknown }` is a weak type, so a row that names none of its members
    // fails the constraint and TS falls back to the constraint itself — which then
    // reports `id` as an excess property and drops `modelVersionId` from the result.
    const out = toApiModelFile<{ id: number; modelVersionId: number; metadata?: unknown }>({
      id: 5,
      modelVersionId: 4242,
    });
    expect(out.modelVersionId).toBe(4242);
    expect(out.metadata.format).toBeUndefined();
  });

  it('a reduced file still pins correctly end-to-end', () => {
    // The two helpers composed the way production composes them.
    const reduced = toApiModelFile({ ...row });
    expect(createSerializedFileDownloadUrl({ file: reduced, hostVersionId: 9999 })).toBe(
      '/api/download/models/9999?fileId=91'
    );
    expect(
      new URL(
        `https://x.test${createSerializedFileDownloadUrl({ file: reduced, hostVersionId: 4242 })}`
      ).searchParams.get('fileId')
    ).toBeNull();
  });
});
