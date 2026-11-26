import { describe, expect, it } from 'vitest';
import { createClaimer, familyDigest } from '~/server/registry-adapter/doc-feed';
import type {
  AppRecordConfig,
  RecordOwnerPolicy,
  RecordSourceRow,
} from '~/server/services/apps/app-record';
import {
  APP_RECORD_BODY_MAX_BYTES,
  appRecordConfig,
  assertRecordBodySize,
  recordBodyBytes,
  recordOwner,
  toAppRecord,
} from '~/server/services/apps/app-record';

/**
 * The record core: the owner rule cell by cell, the URN of a shared and of a private record,
 * the body bound and the switch. Every expectation is a literal. The rev was computed outside
 * this code (a separate sorted-key JSON + SHA-256), so it is not read back from the
 * implementation under test.
 */

// Pairwise distinct: the scope, author and editor users, the key and the record id.
const SCOPE_UID = 48213;
const AUTHOR_UID = 90577;
// A third user who edited the document after its author created it.
const EDITOR_UID = 61349;
const KEY = 'pk-31';
const RECORD_ID = '3f6c1a9e-7b2d-4e58-9a01-c4d2e8f7b630';

const S1 = 'urn:schema:apps.civitai.com:pixel-garden/seed_packs@v1';
const S2 = 'urn:schema:apps.civitai.com:pixel-garden/seed_packs@v2';

// The URN the registry feed publishes for this shared document (`doc-feed.ts`).
const FEED_URN = 'urn:apps.civitai.com:pixel-garden/seed_packs/pk-31';
const PRIVATE_URN =
  'urn:apps.civitai.com:pixel-garden/seed_packs/3f6c1a9e-7b2d-4e58-9a01-c4d2e8f7b630';

function config(): AppRecordConfig {
  const c = appRecordConfig({ APP_RECORD_CORE_ENABLED: true });
  if (!c) throw new Error('fixture: config is null');
  return c;
}

const userAuthor = (uid: number) => ({ kind: 'user' as const, uid, isViewer: false });

function row(over: Partial<RecordSourceRow> = {}): RecordSourceRow {
  return {
    key: KEY,
    data: { title: 'Moss lantern', stars: 4 },
    version: 7,
    author: userAuthor(AUTHOR_UID),
    scopeUid: 0,
    lastWriterUid: AUTHOR_UID,
    recordId: RECORD_ID,
    ...over,
  };
}

describe('appRecordConfig (the switch)', () => {
  it('is off when unset', () => {
    expect(appRecordConfig({})).toBeNull();
  });

  it('is off when switched off', () => {
    expect(appRecordConfig({ APP_RECORD_CORE_ENABLED: false })).toBeNull();
  });

  it('is on when switched on', () => {
    expect(appRecordConfig({ APP_RECORD_CORE_ENABLED: true })).not.toBeNull();
  });

  it('toAppRecord refuses a null config from an untyped caller', () => {
    expect(() =>
      toAppRecord(null as unknown as AppRecordConfig, {
        slug: 'pixel-garden',
        collection: 'seed_packs',
        policy: { kind: 'docs', visibility: 'shared', write: 'own' },
        row: row(),
        writer: { app: 'moss-lab', version: '2.4.1' },
        claim: () => [],
      })
    ).toThrow('switched off');
  });
});

describe('recordOwner: the owner rule, cell by cell', () => {
  type Cell = [
    name: string,
    policy: RecordOwnerPolicy,
    row: Partial<RecordSourceRow>,
    owner: unknown
  ];
  const cells: Cell[] = [
    // Private: the row's scope user, never the author field.
    [
      'private docs → the scope user',
      { kind: 'docs', visibility: 'private' },
      { scopeUid: SCOPE_UID },
      { kind: 'user', userId: SCOPE_UID },
    ],
    [
      'private log → the scope user',
      { kind: 'log', visibility: 'private' },
      { scopeUid: SCOPE_UID },
      { kind: 'user', userId: SCOPE_UID },
    ],
    [
      'private, last written by another user → still the scope user',
      { kind: 'docs', visibility: 'private' },
      { scopeUid: SCOPE_UID, lastWriterUid: EDITOR_UID },
      { kind: 'user', userId: SCOPE_UID },
    ],
    // Shared, created by a user: that user, under every write policy.
    [
      'shared own, user-created → the creator',
      { kind: 'docs', visibility: 'shared', write: 'own' },
      {},
      { kind: 'user', userId: AUTHOR_UID },
    ],
    [
      'shared log own, user-created → the creator',
      { kind: 'log', visibility: 'shared', write: 'own' },
      {},
      { kind: 'user', userId: AUTHOR_UID },
    ],
    [
      'shared, write absent, user-created → the creator',
      { kind: 'docs', visibility: 'shared' },
      {},
      { kind: 'user', userId: AUTHOR_UID },
    ],
    [
      'shared anyone, user-created → the creator',
      { kind: 'docs', visibility: 'shared', write: 'anyone' },
      {},
      { kind: 'user', userId: AUTHOR_UID },
    ],
    [
      'shared anyone, last edited by another user → still the creator',
      { kind: 'docs', visibility: 'shared', write: 'anyone' },
      { lastWriterUid: EDITOR_UID },
      { kind: 'user', userId: AUTHOR_UID },
    ],
    [
      'shared own, last written by another user → still the creator',
      { kind: 'docs', visibility: 'shared', write: 'own' },
      { lastWriterUid: EDITOR_UID },
      { kind: 'user', userId: AUTHOR_UID },
    ],
    // Was "the app" before: a user-authored row under `owner` is its author's.
    [
      'shared owner, user-created → the creator',
      { kind: 'docs', visibility: 'shared', write: 'owner' },
      {},
      { kind: 'user', userId: AUTHOR_UID },
    ],
    // A collection whose write moved from `own` to `none`: its user-authored rows stay theirs.
    [
      'shared none (was own), user-created → the creator',
      { kind: 'docs', visibility: 'shared', write: 'none' },
      {},
      { kind: 'user', userId: AUTHOR_UID },
    ],
    // Created by the app: the app, under every write policy.
    [
      'shared own, app-created → the app',
      { kind: 'docs', visibility: 'shared', write: 'own' },
      { author: { kind: 'app' } },
      { kind: 'app' },
    ],
    [
      'shared anyone, app-created → the app',
      { kind: 'docs', visibility: 'shared', write: 'anyone' },
      { author: { kind: 'app' } },
      { kind: 'app' },
    ],
    [
      'shared owner, app-created → the app',
      { kind: 'docs', visibility: 'shared', write: 'owner' },
      { author: { kind: 'app' } },
      { kind: 'app' },
    ],
    [
      'shared none, app-created → the app',
      { kind: 'docs', visibility: 'shared', write: 'none' },
      { author: { kind: 'app' } },
      { kind: 'app' },
    ],
  ];

  it.each(cells)('%s', (_name, policy, over, owner) => {
    expect(recordOwner(policy, row(over))).toEqual(owner);
  });

  it('refuses a private row with no user scope', () => {
    expect(() =>
      recordOwner({ kind: 'docs', visibility: 'private' }, row({ scopeUid: 0 }))
    ).toThrow('has no user scope');
  });

  it('refuses a shared row with a user scope', () => {
    expect(() =>
      recordOwner(
        { kind: 'docs', visibility: 'shared', write: 'own' },
        row({ scopeUid: SCOPE_UID })
      )
    ).toThrow('has a user scope');
  });
});

describe('the body bound', () => {
  it('is the document store cap, 65536 bytes', () => {
    expect(APP_RECORD_BODY_MAX_BYTES).toBe(65536);
  });

  // `{"s":"` + n + `"}`: n + 8 bytes.
  it('admits a body of exactly the limit', () => {
    const body = { s: 'x'.repeat(65528) };
    expect(recordBodyBytes(body)).toBe(65536);
    expect(() => assertRecordBodySize(body)).not.toThrow();
  });

  it('refuses a body one byte over', () => {
    const body = { s: 'x'.repeat(65529) };
    expect(recordBodyBytes(body)).toBe(65537);
    expect(() => assertRecordBodySize(body)).toThrow('65537 bytes, over the 65536-byte limit');
  });

  // 'é' is 2 bytes in UTF-8: the bound is on bytes, not characters.
  it('counts UTF-8 bytes, not characters', () => {
    expect(() => assertRecordBodySize({ s: 'é'.repeat(32764) })).not.toThrow();
    expect(recordBodyBytes({ s: 'é'.repeat(32765) })).toBe(65538);
    expect(() => assertRecordBodySize({ s: 'é'.repeat(32765) })).toThrow('65538 bytes');
  });
});

describe('toAppRecord', () => {
  const claimBoth = () => [S1, S2];
  const writer = { app: 'moss-lab', version: '2.4.1' };
  const build = (policy: RecordOwnerPolicy, over: Partial<RecordSourceRow> = {}) =>
    toAppRecord(config(), {
      slug: 'pixel-garden',
      collection: 'seed_packs',
      policy,
      row: row(over),
      writer,
      claim: claimBoth,
    });

  it('builds a private record whose URN id is its record_id, owned by the scope user', () => {
    expect(build({ kind: 'docs', visibility: 'private' }, { scopeUid: SCOPE_UID })).toEqual({
      urn: PRIVATE_URN,
      owner: { kind: 'user', userId: SCOPE_UID },
      writer: { app: 'moss-lab', version: '2.4.1' },
      collection: 'seed_packs',
      schemas: [S1, S2],
      rev: '4d289dafd3d7f8f0',
      body: { title: 'Moss lantern', stars: 4 },
    });
  });

  it('builds a private log record the same way', () => {
    expect(build({ kind: 'log', visibility: 'private' }, { scopeUid: SCOPE_UID }).urn).toBe(
      PRIVATE_URN
    );
  });

  // No URN names its owner: two users' private records with the same key differ by record_id.
  it('gives two users’ private records with one key different URNs, neither naming its owner', () => {
    const other = '9d0e4b27-5c3a-4f16-b8e2-71a5c6d3f904';
    const a = build({ kind: 'docs', visibility: 'private' }, { scopeUid: SCOPE_UID });
    const b = build(
      { kind: 'docs', visibility: 'private' },
      { scopeUid: AUTHOR_UID, recordId: other }
    );
    expect(a.urn).toBe(PRIVATE_URN);
    expect(b.urn).toBe(
      'urn:apps.civitai.com:pixel-garden/seed_packs/9d0e4b27-5c3a-4f16-b8e2-71a5c6d3f904'
    );
    for (const r of [a, b]) {
      expect(r.urn).not.toContain(String(SCOPE_UID));
      expect(r.urn).not.toContain(String(AUTHOR_UID));
      expect(r.urn).not.toContain(KEY);
    }
  });

  it('refuses a private row with no record_id rather than inventing one', () => {
    expect(() =>
      build({ kind: 'docs', visibility: 'private' }, { scopeUid: SCOPE_UID, recordId: null })
    ).toThrow('private row pk-31 has no record_id');
  });

  it.each([
    '3F6C1A9E-7B2D-4E58-9A01-C4D2E8F7B630',
    '3f6c1a9e7b2d4e589a01c4d2e8f7b630',
    'pk-31',
    '',
  ])('refuses a private row whose record_id is %j', (recordId) => {
    expect(() =>
      build({ kind: 'docs', visibility: 'private' }, { scopeUid: SCOPE_UID, recordId })
    ).toThrow('malformed record_id');
  });

  // A shared collection is one key space per app: the record keeps the URN the registry feed
  // already publishes for the document, whoever owns it, and never reads record_id.
  it.each([
    ['own', {}, { kind: 'user', userId: AUTHOR_UID }],
    ['anyone', { lastWriterUid: EDITOR_UID }, { kind: 'user', userId: AUTHOR_UID }],
    ['owner', { author: { kind: 'app' } }, { kind: 'app' }],
    ['none', { author: { kind: 'app' } }, { kind: 'app' }],
  ] as const)('a shared %s record keeps the URN the feed publishes', (write, over, owner) => {
    const rec = build({ kind: 'docs', visibility: 'shared', write }, over);
    expect(rec.urn).toBe(FEED_URN);
    expect(rec.owner).toEqual(owner);
  });

  it('a shared record does not need a record_id', () => {
    expect(
      build({ kind: 'docs', visibility: 'shared', write: 'own' }, { recordId: null }).urn
    ).toBe(FEED_URN);
  });

  it('claims the majors with the registry feed’s claimer', () => {
    const family = [
      { urn: S1, body: { type: 'object' } },
      { urn: S2, body: { type: 'object', required: ['title'] } },
    ];
    const claim = createClaimer()(family, familyDigest(family));
    const withClaim = (data: Record<string, unknown>) =>
      toAppRecord(config(), {
        slug: 'pixel-garden',
        collection: 'seed_packs',
        policy: { kind: 'docs', visibility: 'private' },
        row: row({ scopeUid: SCOPE_UID, data }),
        writer,
        claim,
      });
    const both = withClaim({ title: 'Moss lantern', stars: 4 });
    expect(both.schemas).toEqual([S1, S2]);
    expect(both.rev).toBe('4d289dafd3d7f8f0');
    expect(withClaim({ stars: 4 }).schemas).toEqual([S1]);
  });

  it('refuses a body over the limit', () => {
    expect(() =>
      build(
        { kind: 'docs', visibility: 'private' },
        { scopeUid: SCOPE_UID, data: { s: 'x'.repeat(65529) } }
      )
    ).toThrow('over the 65536-byte limit');
  });
});
