import { describe, expect, it } from 'vitest';
import { createClaimer, docRev, familyDigest } from '~/server/registry-adapter/doc-feed';
import { OWNER_HANDLE_RE, parseOwnedDocumentUrn, registryUrn } from '~/server/registry-adapter/urn';
import type {
  AppRecordConfig,
  RecordOwnerPolicy,
  RecordSourceRow,
} from '~/server/services/apps/app-record';
import {
  APP_RECORD_BODY_MAX_BYTES,
  appRecordConfig,
  assertRecordBodySize,
  ownerHandle,
  recordBodyBytes,
  recordOwner,
  toAppRecord,
} from '~/server/services/apps/app-record';

/**
 * The record core: the owner policy table cell by cell, the owner handle, the body bound and
 * the record built from a stored row. Every expectation is a literal. The handles and revs were
 * computed outside this code (openssl HMAC-SHA256, and a separate sorted-key JSON + SHA-256), so
 * none is read back from the implementation under test.
 */

// 41 and 41 bytes, both over the 32-byte minimum, and different from each other.
const KEY = 'fixture-owner-handle-key-7f3a9c2e5b81d064';
const OTHER_KEY = 'fixture-other-handle-key-1d5e8b0c4a92f736';

// Pairwise distinct: the scope, author and editor users, none a substring of another.
const SCOPE_UID = 48213;
const AUTHOR_UID = 90577;
// A third user who edited the document after its author created it.
const EDITOR_UID = 61349;
// HMAC-SHA256(KEY, 'app-record-owner-handle:v1:<uid>')[0..16] in unpadded base64url.
const SCOPE_HANDLE = 'Zb-suruP-fFtbvjjunifdw';
const AUTHOR_HANDLE = '3Uipx1H4DxzUWDg9kOP_pA';
// The same for SCOPE_UID under OTHER_KEY.
const SCOPE_HANDLE_OTHER_KEY = 'CaQvWlUuLtDM-C4WZ059fw';

const S1 = 'urn:schema:apps.civitai.com:pixel-garden/seed_packs@v1';
const S2 = 'urn:schema:apps.civitai.com:pixel-garden/seed_packs@v2';

function config(key = KEY): AppRecordConfig {
  const c = appRecordConfig({ APP_RECORD_CORE_ENABLED: true, APP_RECORD_OWNER_HANDLE_KEY: key });
  if (!c) throw new Error('fixture: config is null');
  return c;
}

const userAuthor = (uid: number) => ({ kind: 'user' as const, uid, isViewer: false });

function row(over: Partial<RecordSourceRow> = {}): RecordSourceRow {
  return {
    key: 'pk-31',
    data: { title: 'Moss lantern', stars: 4 },
    version: 7,
    author: userAuthor(AUTHOR_UID),
    scopeUid: 0,
    lastWriterUid: AUTHOR_UID,
    ...over,
  };
}

describe('appRecordConfig (the switch)', () => {
  it('is off when nothing is set', () => {
    expect(appRecordConfig({})).toBeNull();
  });

  it('is off while the switch is off, even with a key', () => {
    expect(
      appRecordConfig({ APP_RECORD_CORE_ENABLED: false, APP_RECORD_OWNER_HANDLE_KEY: KEY })
    ).toBeNull();
    expect(appRecordConfig({ APP_RECORD_OWNER_HANDLE_KEY: KEY })).toBeNull();
  });

  it('is off with the switch on and no key', () => {
    expect(appRecordConfig({ APP_RECORD_CORE_ENABLED: true })).toBeNull();
    expect(
      appRecordConfig({ APP_RECORD_CORE_ENABLED: true, APP_RECORD_OWNER_HANDLE_KEY: '' })
    ).toBeNull();
  });

  it('is on with the switch on and a key', () => {
    expect(
      appRecordConfig({ APP_RECORD_CORE_ENABLED: true, APP_RECORD_OWNER_HANDLE_KEY: KEY })
    ).toEqual({ handleKey: KEY });
  });

  it('refuses a key under 32 bytes, and takes one of exactly 32', () => {
    expect(() =>
      appRecordConfig({
        APP_RECORD_CORE_ENABLED: true,
        APP_RECORD_OWNER_HANDLE_KEY: 'k'.repeat(31),
      })
    ).toThrow('at least 32 bytes');
    expect(
      appRecordConfig({
        APP_RECORD_CORE_ENABLED: true,
        APP_RECORD_OWNER_HANDLE_KEY: 'k'.repeat(32),
      })
    ).toEqual({ handleKey: 'k'.repeat(32) });
  });
});

describe('recordOwner: the policy table, cell by cell', () => {
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
    // Shared, own: the author.
    [
      'shared own → the author',
      { kind: 'docs', visibility: 'shared', write: 'own' },
      {},
      { kind: 'user', userId: AUTHOR_UID },
    ],
    [
      'shared log own → the author',
      { kind: 'log', visibility: 'shared', write: 'own' },
      {},
      { kind: 'user', userId: AUTHOR_UID },
    ],
    [
      'shared, write absent (read as own) → the author',
      { kind: 'docs', visibility: 'shared' },
      {},
      { kind: 'user', userId: AUTHOR_UID },
    ],
    [
      'shared own, authored by the app → the app',
      { kind: 'docs', visibility: 'shared', write: 'own' },
      { author: { kind: 'app' } },
      { kind: 'app' },
    ],
    // Shared, owner: the app, whoever the author field names.
    [
      'shared owner → the app',
      { kind: 'docs', visibility: 'shared', write: 'owner' },
      { author: { kind: 'app' } },
      { kind: 'app' },
    ],
    [
      'shared owner, user author field → still the app',
      { kind: 'docs', visibility: 'shared', write: 'owner' },
      {},
      { kind: 'app' },
    ],
    // Shared, none: an aggregate.
    [
      'shared none → nobody',
      { kind: 'docs', visibility: 'shared', write: 'none' },
      {},
      { kind: 'nobody' },
    ],
    // Shared, anyone: the creator, fixed at creation; a later editor never takes it over.
    [
      'shared anyone → the creator',
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
      'shared anyone, created by the app → the app',
      { kind: 'docs', visibility: 'shared', write: 'anyone' },
      { author: { kind: 'app' } },
      { kind: 'app' },
    ],
    [
      'shared own, last written by another user → still the author',
      { kind: 'docs', visibility: 'shared', write: 'own' },
      { lastWriterUid: EDITOR_UID },
      { kind: 'user', userId: AUTHOR_UID },
    ],
    [
      'private, last written by another user → still the scope user',
      { kind: 'docs', visibility: 'private' },
      { scopeUid: SCOPE_UID, lastWriterUid: EDITOR_UID },
      { kind: 'user', userId: SCOPE_UID },
    ],
    // A counter document is nobody's under every shared policy.
    [
      'counter document under own → nobody',
      { kind: 'docs', visibility: 'shared', write: 'own' },
      { author: { kind: 'counter' }, data: {} },
      { kind: 'nobody' },
    ],
    [
      'counter document under owner → nobody',
      { kind: 'docs', visibility: 'shared', write: 'owner' },
      { author: { kind: 'counter' }, data: {} },
      { kind: 'nobody' },
    ],
    [
      'counter document under anyone → nobody',
      { kind: 'docs', visibility: 'shared', write: 'anyone' },
      { author: { kind: 'counter' }, data: {} },
      { kind: 'nobody' },
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

describe('ownerHandle', () => {
  it('is the keyed digest, pinned', () => {
    expect(ownerHandle(config(), SCOPE_UID)).toBe(SCOPE_HANDLE);
    expect(ownerHandle(config(), AUTHOR_UID)).toBe(AUTHOR_HANDLE);
  });

  it('is deterministic', () => {
    expect(ownerHandle(config(), SCOPE_UID)).toBe(ownerHandle(config(), SCOPE_UID));
  });

  it('differs between two users', () => {
    expect(ownerHandle(config(), SCOPE_UID)).not.toBe(ownerHandle(config(), AUTHOR_UID));
  });

  it('depends on the key', () => {
    expect(ownerHandle(config(OTHER_KEY), SCOPE_UID)).toBe(SCOPE_HANDLE_OTHER_KEY);
  });

  it('never contains the user id', () => {
    for (const uid of [SCOPE_UID, AUTHOR_UID]) {
      expect(ownerHandle(config(), uid)).not.toContain(String(uid));
    }
  });

  it('is 22 URL-safe characters a URN accepts', () => {
    for (const uid of [SCOPE_UID, AUTHOR_UID]) {
      const h = ownerHandle(config(), uid);
      expect(h).toHaveLength(22);
      expect(OWNER_HANDLE_RE.test(h)).toBe(true);
    }
  });

  it.each([0, -3, 1.5, Number.NaN])('refuses user id %s', (uid) => {
    expect(() => ownerHandle(config(), uid)).toThrow('invalid user id');
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

  it('builds a private record under the scope user’s handle', () => {
    const rec = toAppRecord(config(), {
      slug: 'pixel-garden',
      collection: 'seed_packs',
      policy: { kind: 'docs', visibility: 'private' },
      row: row({ scopeUid: SCOPE_UID }),
      writer,
      claim: claimBoth,
    });
    expect(rec).toEqual({
      urn: `urn:apps.civitai.com:pixel-garden/seed_packs/${SCOPE_HANDLE}/pk-31`,
      owner: { kind: 'user', userId: SCOPE_UID },
      writer: { app: 'moss-lab', version: '2.4.1' },
      collection: 'seed_packs',
      schemas: [S1, S2],
      rev: '4d289dafd3d7f8f0',
      body: { title: 'Moss lantern', stars: 4 },
    });
    expect(parseOwnedDocumentUrn(rec.urn)).toEqual({
      slug: 'pixel-garden',
      collection: 'seed_packs',
      handle: SCOPE_HANDLE,
      key: 'pk-31',
    });
  });

  it('carries the same rev as the registry feed for the same document', () => {
    const r = row({ scopeUid: SCOPE_UID });
    const rec = toAppRecord(config(), {
      slug: 'pixel-garden',
      collection: 'seed_packs',
      policy: { kind: 'docs', visibility: 'private' },
      row: r,
      writer,
      claim: claimBoth,
    });
    expect(rec.rev).toBe(docRev(r, [S1, S2]));
  });

  // A shared collection is one key space per app, and the registry feed already publishes its
  // documents as `<slug>/<coll>/<key>` (doc-feed.ts builds it with `registryUrn` kind
  // `document`). A record of the same document must carry that same URN, whoever owns it.
  const FEED_URN = 'urn:apps.civitai.com:pixel-garden/seed_packs/pk-31';

  it.each([
    ['own', {}],
    ['anyone', { lastWriterUid: EDITOR_UID }],
  ] as const)(
    'a shared %s record, owned by its creator, keeps the URN the feed publishes',
    (write, over) => {
      const rec = toAppRecord(config(), {
        slug: 'pixel-garden',
        collection: 'seed_packs',
        policy: { kind: 'docs', visibility: 'shared', write },
        row: row(over),
        writer,
        claim: claimBoth,
      });
      expect(rec.urn).toBe(FEED_URN);
      expect(rec.urn).toBe(
        registryUrn({
          kind: 'document',
          slug: 'pixel-garden',
          collection: 'seed_packs',
          key: 'pk-31',
        })
      );
      expect(parseOwnedDocumentUrn(rec.urn)).toBeNull();
      expect(rec.urn).not.toContain(AUTHOR_HANDLE);
      expect(rec.owner).toEqual({ kind: 'user', userId: AUTHOR_UID });
    }
  );

  it('builds a private log record under the scope user’s handle too', () => {
    const rec = toAppRecord(config(), {
      slug: 'pixel-garden',
      collection: 'seed_packs',
      policy: { kind: 'log', visibility: 'private' },
      row: row({ scopeUid: SCOPE_UID }),
      writer,
      claim: claimBoth,
    });
    expect(rec.urn).toBe(`urn:apps.civitai.com:pixel-garden/seed_packs/${SCOPE_HANDLE}/pk-31`);
  });

  it('gives one user the same handle in two apps, so their records join', () => {
    const urnIn = (slug: string) =>
      toAppRecord(config(), {
        slug,
        collection: 'seed_packs',
        policy: { kind: 'docs', visibility: 'private' },
        row: row({ scopeUid: SCOPE_UID }),
        writer,
        claim: claimBoth,
      }).urn;
    expect(parseOwnedDocumentUrn(urnIn('pixel-garden'))?.handle).toBe(SCOPE_HANDLE);
    expect(parseOwnedDocumentUrn(urnIn('moss-lab'))?.handle).toBe(SCOPE_HANDLE);
  });

  it.each([
    ['owner', { kind: 'app' }],
    ['none', { kind: 'nobody' }],
  ] as const)('a shared %s record keeps the URN the feed publishes', (write, owner) => {
    const rec = toAppRecord(config(), {
      slug: 'pixel-garden',
      collection: 'seed_packs',
      policy: { kind: 'docs', visibility: 'shared', write },
      row: row(),
      writer,
      claim: claimBoth,
    });
    expect(rec.urn).toBe(FEED_URN);
    expect(rec.owner).toEqual(owner);
  });

  it('claims the majors with the registry feed’s claimer', () => {
    const family = [
      { urn: S1, body: { type: 'object' } },
      { urn: S2, body: { type: 'object', required: ['title'] } },
    ];
    const claim = createClaimer()(family, familyDigest(family));
    const build = (data: Record<string, unknown>) =>
      toAppRecord(config(), {
        slug: 'pixel-garden',
        collection: 'seed_packs',
        policy: { kind: 'docs', visibility: 'private' },
        row: row({ scopeUid: SCOPE_UID, data }),
        writer,
        claim,
      });
    const both = build({ title: 'Moss lantern', stars: 4 });
    expect(both.schemas).toEqual([S1, S2]);
    expect(both.rev).toBe('4d289dafd3d7f8f0');
    const first = build({ stars: 4 });
    expect(first.schemas).toEqual([S1]);
  });

  it('refuses a body over the limit', () => {
    expect(() =>
      toAppRecord(config(), {
        slug: 'pixel-garden',
        collection: 'seed_packs',
        policy: { kind: 'docs', visibility: 'private' },
        row: row({ scopeUid: SCOPE_UID, data: { s: 'x'.repeat(65529) } }),
        writer,
        claim: claimBoth,
      })
    ).toThrow('over the 65536-byte limit');
  });
});
