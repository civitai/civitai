import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { S3Client } from '@aws-sdk/client-s3';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The route and the page action against the real preserved-view and mod-activity code on PGlite: only
 * the page grant, Axiom and the store's network call are stubbed.
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('$lib/server/db', () => ({
  get dbRead() {
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('$lib/server/access', () => ({ canAccess: () => true }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: async () => {} }));

const { GET } = await import('../../../routes/api/preserved-view/[n]/+server');
const { actions } = await import('../../../routes/csam/preserved-view/+page.server');

const A = { id: 501, roles: ['moderator:preserved-review'] };
const B = { id: 502, roles: ['moderator:preserved-review'] };
const MANIFEST_KEY = 'fixture/run-1/manifest.json';
const KEYS = ['fixture/held/a.png', 'fixture/held/b.png'];
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const FILES = [0, 10].map((s) =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, s, s + 1])
);
const MANIFEST = new TextEncoder().encode(
  JSON.stringify({
    entries: KEYS.map((key, i) => ({
      status: 'external',
      size: FILES[i].byteLength,
      sha256: sha(FILES[i]),
      source: { bucket: 'held', key },
    })),
  })
);
const objects = new Map<string, Uint8Array>();

const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: {
  input: { Key: string };
}) => {
  const bytes = objects.get(command.input.Key);
  if (!bytes) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
  return { Body: Readable.from([Buffer.from(bytes)]), ContentLength: bytes.byteLength };
}) as never);

let db: PGlite;
beforeAll(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "ModActivity" (
      "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
      "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), "credential" TEXT
    );`);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
  Object.assign(process.env, {
    PRESERVED_VIEW_MANIFEST_KEY: MANIFEST_KEY,
    PRESERVED_VIEW_MANIFEST_SHA256: sha(MANIFEST),
    PRESERVED_VIEW_USER_IDS: `${A.id},${B.id}`,
    PRESERVED_VIEW_S3_ENDPOINT: 'https://store.test',
    PRESERVED_VIEW_S3_BUCKET: 'held',
    PRESERVED_VIEW_S3_KEY: 'test-key',
    PRESERVED_VIEW_S3_SECRET: 'test-secret',
  });
});
afterAll(async () => {
  send.mockRestore();
  await db?.close();
});
beforeEach(async () => {
  await db.exec('TRUNCATE "ModActivity" RESTART IDENTITY');
  objects.clear();
  objects.set(MANIFEST_KEY, MANIFEST);
  KEYS.forEach((key, i) => objects.set(key, FILES[i]));
});

async function open(n: number, user: unknown) {
  const url = new URL(`http://mod.test/api/preserved-view/${n}`);
  try {
    const res = await GET({
      params: { n: String(n) },
      url,
      request: new Request(url, {
        headers: { 'sec-fetch-site': 'same-origin', 'x-preserved-view': 'open' },
      }),
      locals: { user, grants: {} },
    } as never);
    return res.status;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
}

async function rule(n: number, verdict: string, user: unknown) {
  const body = new FormData();
  body.set('n', String(n));
  body.set('verdict', verdict);
  const request = new Request('http://mod.test/csam/preserved-view?/verdict', {
    method: 'POST',
    body,
  });
  const out = (await actions.verdict({ request, locals: { user, grants: {} } } as never)) as
    | { status: number }
    | { recorded: number };
  return 'status' in out ? out.status : 'recorded';
}

const activities = async () =>
  (
    await db.query<{ userId: number; activity: string; entityId: number }>(
      'SELECT "userId", "activity", "entityId" FROM "ModActivity" ORDER BY "id"'
    )
  ).rows.map((r) => `${r.userId} ${r.activity} ${r.entityId}`);

describe('a review, end to end', () => {
  it('serves, records one verdict, then stops serving', async () => {
    expect(await rule(1, 'not', A)).toBe(409);
    expect(await open(1, A)).toBe(200);
    expect(await rule(1, 'not', A)).toBe('recorded');
    expect(await rule(1, 'apparent', A)).toBe(409);
    expect(await open(1, A)).toBe(410);
    expect(await activities()).toEqual([
      '501 preservedFile:served 1',
      '501 preservedFile:delivered 1',
      '501 preservedFile:verdict-not 1',
    ]);
  });

  it('lets only a reviewer who was sent the file rule on it, and only the first verdict stands', async () => {
    expect(await open(2, B)).toBe(200);
    expect(await rule(2, 'not', A)).toBe(409);
    expect(await open(2, A)).toBe(200);
    expect(await rule(2, 'apparent', B)).toBe('recorded');
    expect(await rule(2, 'not', A)).toBe(409);
    expect(await open(2, A)).toBe(410);
  });

  it('records no delivery for bytes that do not match, so no verdict can follow', async () => {
    objects.set(KEYS[0], Uint8Array.from([...FILES[0], 0]));
    expect(await open(1, A)).toBe(409);
    expect(await rule(1, 'not', A)).toBe(409);
    expect(await activities()).toEqual(['501 preservedFile:served 1']);
  });
});
