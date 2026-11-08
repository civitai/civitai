import { describe, expect, it } from 'vitest';
import type { CollectionMajors } from '~/server/services/apps/storage-schema-majors';
import {
  applyMajorChain,
  currentCollectionMajors,
  deriveCollectionMajors,
  HEAD_STEP,
  manifestHistory,
} from '~/server/services/apps/storage-schema-majors';

/**
 * The shared majors module's own additions: the history order, the current major of each
 * collection and the forward step chain. The derivation itself (`isAdditive`,
 * `deriveCollectionMajors`, `migrateSteps`) moved here unchanged from the registry adapter, and its
 * table of cases still runs, unchanged, in `registry-adapter/__tests__/collection-schema.test.ts`
 * through the adapter's re-export. Every expectation is a literal.
 */

type S = Record<string, unknown>;
const obj = (properties: S, extra: S = {}): S => ({ type: 'object', properties, ...extra });
const manifest = (collections: S) => ({ blockId: 'pixel-garden', storage: { collections } });
const at = (iso: string) => new Date(iso);

describe('manifestHistory', () => {
  it('orders by reviewedAt (a missing one first), then by id, and ends with the enforced manifest', () => {
    const steps = manifestHistory(
      [
        { id: 'pubreq_c', manifest: 'C', reviewedAt: at('2026-10-03T00:00:00Z') },
        { id: 'pubreq_b2', manifest: 'B2', reviewedAt: at('2026-10-02T00:00:00Z') },
        { id: 'pubreq_none', manifest: 'N', reviewedAt: null },
        { id: 'pubreq_b1', manifest: 'B1', reviewedAt: at('2026-10-02T00:00:00Z') },
      ],
      'HEAD-MANIFEST'
    );
    expect(steps).toEqual([
      { id: 'pubreq_none', manifest: 'N' },
      { id: 'pubreq_b1', manifest: 'B1' },
      { id: 'pubreq_b2', manifest: 'B2' },
      { id: 'pubreq_c', manifest: 'C' },
      { id: 'head', manifest: 'HEAD-MANIFEST' },
    ]);
  });

  it('does not reorder the array it is given', () => {
    const approved = [
      { id: 'pubreq_z', manifest: 1, reviewedAt: at('2026-10-09T00:00:00Z') },
      { id: 'pubreq_a', manifest: 2, reviewedAt: at('2026-10-01T00:00:00Z') },
    ];
    manifestHistory(approved, null);
    expect(approved.map((r) => r.id)).toEqual(['pubreq_z', 'pubreq_a']);
  });
});

describe('currentCollectionMajors', () => {
  const SEED = obj({ title: { type: 'string' } });
  const SEED_REQUIRED = obj({ title: { type: 'string' } }, { required: ['title'] });

  it('is the major each collection the enforced manifest declares is on', () => {
    const d = deriveCollectionMajors([
      { id: 'pubreq_a', manifest: manifest({ cards: { visibility: 'private', schema: SEED } }) },
      {
        id: 'pubreq_b',
        manifest: manifest({
          cards: { visibility: 'private', schema: SEED_REQUIRED },
          notes: { visibility: 'private' },
        }),
      },
      {
        id: HEAD_STEP,
        manifest: manifest({
          cards: { visibility: 'private', schema: SEED_REQUIRED },
          notes: { visibility: 'private' },
        }),
      },
    ]);
    expect(currentCollectionMajors(d)).toEqual(
      new Map([
        ['cards', 2],
        ['notes', 1],
      ])
    );
  });

  it('a collection the enforced manifest dropped has none, though earlier steps declared it', () => {
    const d = deriveCollectionMajors([
      { id: 'pubreq_a', manifest: manifest({ cards: { visibility: 'private' } }) },
      { id: HEAD_STEP, manifest: manifest({ notes: { visibility: 'private' } }) },
    ]);
    expect(currentCollectionMajors(d)).toEqual(new Map([['notes', 1]]));
  });

  it('an enforced manifest whose storage does not parse declares nothing', () => {
    const d = deriveCollectionMajors([
      { id: 'pubreq_a', manifest: manifest({ cards: { visibility: 'private' } }) },
      { id: HEAD_STEP, manifest: manifest({ cards: { visibility: 9 } }) },
    ]);
    expect(currentCollectionMajors(d)).toEqual(new Map());
  });

  it('no enforced manifest step at all: nothing', () => {
    const d = deriveCollectionMajors([
      { id: 'pubreq_a', manifest: manifest({ cards: { visibility: 'private' } }) },
    ]);
    expect(currentCollectionMajors(d)).toEqual(new Map());
  });
});

describe('applyMajorChain', () => {
  // @v1 {name, legacy, stars} → @v2: rename name → title, remove legacy (closed schema)
  // → @v3: default status 'draft' (newly required).
  const CHAIN: Pick<CollectionMajors, 'majors' | 'migrations'> = {
    majors: [
      obj({ name: {}, legacy: {}, stars: {} }, { additionalProperties: false }),
      obj({ title: {}, stars: {} }, { additionalProperties: false }),
      obj(
        { title: {}, stars: {}, status: {} },
        { additionalProperties: false, required: ['status'] }
      ),
    ],
    migrations: [
      null,
      [
        { op: 'rename', from: '/name', to: '/title' },
        { op: 'remove', path: '/legacy' },
      ],
      [{ op: 'default', path: '/status', value: 'draft' }],
    ],
  };
  const V1_BODY = { name: 'Fern', legacy: 'x-91', stars: 4 };

  it('1 → 3 applies each major’s steps in turn', () => {
    expect(applyMajorChain(CHAIN, V1_BODY, 1, 3)).toEqual({
      title: 'Fern',
      stars: 4,
      status: 'draft',
    });
  });

  it('1 → 2 stops at major 2', () => {
    expect(applyMajorChain(CHAIN, V1_BODY, 1, 2)).toEqual({ title: 'Fern', stars: 4 });
  });

  it('2 → 3 applies only major 3’s steps (a v2 body keeps a stray `name`)', () => {
    expect(applyMajorChain(CHAIN, { title: 'Moss', name: 'stray-7', stars: 2 }, 2, 3)).toEqual({
      title: 'Moss',
      name: 'stray-7',
      stars: 2,
      status: 'draft',
    });
  });

  it('a body already in the newer shape comes through unchanged', () => {
    const v3 = { title: 'Ivy', stars: 5, status: 'live' };
    expect(applyMajorChain(CHAIN, v3, 1, 3)).toEqual(v3);
  });

  it('n → n is an unchanged copy, and the input is never changed', () => {
    const body = { ...V1_BODY };
    const same = applyMajorChain(CHAIN, body, 1, 1);
    expect(same).toEqual(V1_BODY);
    expect(same).not.toBe(body);
    applyMajorChain(CHAIN, body, 1, 3);
    expect(body).toEqual(V1_BODY);
  });

  it.each([
    [0, 2],
    [1, 4],
    [3, 2],
    [1.5, 3],
  ])('refuses a chain from %s to %s', (from, to) => {
    expect(() => applyMajorChain(CHAIN, V1_BODY, from, to)).toThrow(RangeError);
  });

  it('over majors derived from a real history, the minting transition’s ops are the steps', () => {
    const CLOSED = { additionalProperties: false };
    const d = deriveCollectionMajors([
      {
        id: 'pubreq_a',
        manifest: manifest({
          cards: { visibility: 'private', schema: obj({ name: {}, keep: {} }, CLOSED) },
        }),
      },
      {
        id: HEAD_STEP,
        manifest: manifest({
          cards: {
            visibility: 'private',
            schema: obj({ title: {}, keep: {} }, CLOSED),
            migrations: [{ op: 'rename', from: '/name', to: '/title' }],
          },
        }),
      },
    ]);
    const cards = d.collections.get('cards');
    if (!cards) throw new Error('cards not derived');
    expect(applyMajorChain(cards, { name: 'Sage', keep: 3 }, 1, 2)).toEqual({
      title: 'Sage',
      keep: 3,
    });
  });
});
