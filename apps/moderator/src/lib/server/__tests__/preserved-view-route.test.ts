import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PreservedViewModule from '../preserved-view';

/**
 * The preserved-file review: the files of a pinned manifest, served to its named reviewers, each serve
 * audited before the store is called. The store is the real client with `send` stubbed, so the
 * allowlist and the order of calls are what production runs. The SQL behind the mocked reads is pinned
 * in preserved-view.pglite.test.ts.
 */

const state = vi.hoisted(() => ({
  grants: new Set<string>(),
  verdicts: new Map<number, 'apparent' | 'not'>(),
  delivered: new Set<string>(),
  failActivity: null as string | null,
  rowExists: true,
  ruleDuringAudit: null as number | null,
  ruleOnRead: null as number | null,
  order: [] as string[],
}));
const insertModActivity = vi.hoisted(() =>
  vi.fn(async (row: Record<string, unknown>) => {
    state.order.push(`audit:${String(row.activity)}`);
    if (state.failActivity === row.activity) throw new Error('db down');
    if (state.ruleDuringAudit) state.verdicts.set(state.ruleDuringAudit, 'not');
    return 77;
  })
);
const modActivityRowExists = vi.hoisted(() => vi.fn(async (_id: number) => state.rowExists));
const logToAxiom = vi.hoisted(() => vi.fn(async (_line: Record<string, unknown>) => {}));
const recordPreservedVerdict = vi.hoisted(() =>
  vi.fn(
    async (_file: unknown, _reviewer: number, _verdict: string) =>
      'recorded' as 'recorded' | 'already'
  )
);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb([], []), dbWrite: capturingDb([], []) };
});
vi.mock('$lib/server/access', () => ({
  canAccess: (_user: unknown, path: string) => state.grants.has(path),
}));
vi.mock('$lib/server/mod-activity', () => ({ insertModActivity, modActivityRowExists }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom }));
vi.mock('$lib/server/preserved-view', async (importOriginal) => ({
  ...(await importOriginal<typeof PreservedViewModule>()),
  preservedVerdicts: async (files: { n: number }[]) =>
    new Map([...state.verdicts].filter(([n]) => files.some((f) => f.n === n))),
  deliveredTo: async (files: { n: number }[], reviewerId: number) =>
    new Set(files.filter((f) => state.delivered.has(`${reviewerId}:${f.n}`)).map((f) => f.n)),
  recordDelivery: async (file: { n: number }, reviewerId: number) => {
    if (state.verdicts.has(file.n)) return 'ruled';
    if (state.failActivity === 'preservedFile:delivered') return 'failed';
    state.order.push(DELIVERED);
    state.delivered.add(`${reviewerId}:${file.n}`);
    return 'delivered';
  },
  recordPreservedVerdict,
}));

const { GET } = await import('../../../routes/api/preserved-view/[n]/+server');
const { actions, load } = await import('../../../routes/csam/preserved-view/+page.server');
const { createPreservedObjectStore, OversizeObjectError, UnlistedKeyError } = await import(
  '../preserved-object-store'
);
const { openPreservedFiles, readPreservedViewConfig, sniffImageType } = await import(
  '../preserved-view'
);

const CAP = 10 * 1024 * 1024;

const PAGE = '/csam/preserved-view';
const REVIEWER = { id: 501, roles: ['moderator:preserved-review'] };
const REVIEWER_2 = { id: 502, roles: ['moderator:preserved-review'] };
const ADMIN = { id: 900, roles: ['moderator:admin'] };
const MANIFEST_KEY = 'fixture/run-1/manifest.json';
const FILE_KEYS = ['fixture/held/a.png', 'fixture/held/b.png', 'fixture/held/c.png'];
const SERVED = 'audit:preservedFile:served';
const DELIVERED = 'audit:preservedFile:delivered';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const png = (seed: number) =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, seed + 1, seed + 2]);
const FILES = FILE_KEYS.map((_, i) => png(i * 10));

function manifestBytes(entries: unknown[]) {
  return new TextEncoder().encode(JSON.stringify({ version: 1, run: {}, entries, skipped: [] }));
}
const entry = (key: string, bytes: Uint8Array) => ({
  status: 'external',
  path: `files/${key}`,
  size: bytes.byteLength,
  sha256: sha(bytes),
  source: { store: 'held', bucket: 'held', key },
});
const ENTRIES = FILE_KEYS.map((key, i) => entry(key, FILES[i]));
const MANIFEST = manifestBytes(ENTRIES);

const objects = new Map<string, Uint8Array | Error>();
const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: {
  input: { Key: string };
}) => {
  state.order.push(`get:${command.input.Key}`);
  if (state.ruleOnRead && FILE_KEYS.includes(command.input.Key))
    state.verdicts.set(state.ruleOnRead, 'not');
  const bytes = objects.get(command.input.Key);
  if (bytes instanceof Error) throw bytes;
  if (!bytes) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
  return { Body: Readable.from([Buffer.from(bytes)]), ContentLength: bytes.byteLength };
}) as never);
afterAll(() => send.mockRestore());

const ENV = {
  PRESERVED_VIEW_MANIFEST_KEY: MANIFEST_KEY,
  PRESERVED_VIEW_MANIFEST_SHA256: sha(MANIFEST),
  PRESERVED_VIEW_USER_IDS: `${REVIEWER.id},${REVIEWER_2.id}`,
  PRESERVED_VIEW_S3_ENDPOINT: 'https://store.test',
  PRESERVED_VIEW_S3_BUCKET: 'held',
  PRESERVED_VIEW_S3_KEY: 'test-key',
  PRESERVED_VIEW_S3_SECRET: 'test-secret',
};

function pinManifest(entries: unknown[]) {
  const manifest = manifestBytes(entries);
  objects.set(MANIFEST_KEY, manifest);
  process.env.PRESERVED_VIEW_MANIFEST_SHA256 = sha(manifest);
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, ENV);
  state.grants = new Set([PAGE]);
  state.verdicts = new Map();
  state.delivered = new Set();
  state.failActivity = null;
  state.rowExists = true;
  state.ruleDuringAudit = null;
  state.ruleOnRead = null;
  state.order = [];
  objects.clear();
  objects.set(MANIFEST_KEY, MANIFEST);
  FILE_KEYS.forEach((key, i) => objects.set(key, FILES[i]));
});

type Outcome = { status: number; res?: Response };

async function get(
  n: string,
  {
    search = '',
    method = 'GET',
    user = REVIEWER as unknown,
    site = 'same-origin' as string | null,
    marker = 'open' as string | null,
  } = {}
): Promise<Outcome> {
  const url = new URL(`http://mod.test/api/preserved-view/${n}${search}`);
  try {
    const res = await GET({
      params: { n },
      url,
      request: new Request(url, {
        method,
        headers: {
          ...(site ? { 'sec-fetch-site': site } : {}),
          ...(marker ? { 'x-preserved-view': marker } : {}),
        },
      }),
      locals: { user, grants: {} },
    } as never);
    return { status: res.status, res };
  } catch (e) {
    return { status: (e as { status?: number }).status ?? 500 };
  }
}

const fileReads = () => state.order.filter((step) => FILE_KEYS.some((k) => step === `get:${k}`));
const serveLine = () => {
  const line = logToAxiom.mock.calls.at(-1)?.[0];
  return line && { ...line, ...(line.payload as object) };
};

describe('serving a file', () => {
  it('serves the pinned bytes between the served row and the delivered row', async () => {
    const { status, res } = await get('2');
    expect(status).toBe(200);
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(FILES[1]);
    expect(res!.headers.get('content-type')).toBe('image/png');
    expect(res!.headers.get('cache-control')).toBe('private, no-store');
    expect(res!.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res!.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res!.headers.get('accept-ranges')).toBe('none');
    expect(state.order).toEqual([`get:${MANIFEST_KEY}`, SERVED, `get:${FILE_KEYS[1]}`, DELIVERED]);
    expect(modActivityRowExists).toHaveBeenCalledWith(77);
    expect(insertModActivity).toHaveBeenNthCalledWith(1, {
      userId: REVIEWER.id,
      entityType: `preservedFile:${sha(FILES[1]).slice(0, 16)}`,
      entityId: 2,
      activity: 'preservedFile:served',
      credential: 'web',
    });
  });

  it.each(['0', '4', '-1', '01', '1.0', 'abc', '99', '100'])(
    'refuses file number %s',
    async (n) => {
      expect((await get(n)).status).toBe(404);
      expect(insertModActivity).not.toHaveBeenCalled();
      expect(fileReads()).toEqual([]);
    }
  );

  it('refuses a request that names a key, before touching the store', async () => {
    const search = `?key=${encodeURIComponent(FILE_KEYS[2])}`;
    expect((await get('1', { search })).status).toBe(404);
    expect(send).not.toHaveBeenCalled();
    expect(insertModActivity).not.toHaveBeenCalled();
  });

  it.each([['cross-site'], ['same-site'], ['none'], [null]])(
    'refuses a request whose Sec-Fetch-Site is %s, before any audit row',
    async (site) => {
      expect((await get('1', { site })).status).toBe(403);
      expect(insertModActivity).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    }
  );

  it('refuses everything when the manifest does not match its pinned sha256', async () => {
    process.env.PRESERVED_VIEW_MANIFEST_SHA256 = sha(manifestBytes(ENTRIES.slice(0, 2)));
    expect((await get('1')).status).toBe(409);
    expect(state.order).toEqual([`get:${MANIFEST_KEY}`]);
  });

  it.each([
    [
      'an entry whose hash disagrees with its pinned input',
      () =>
        pinManifest(
          ENTRIES.map((e, i) => (i ? e : { ...e, pinned: { size: e.size, sha256: sha(FILES[2]) } }))
        ),
    ],
    [
      'an entry over the size cap',
      () => pinManifest(ENTRIES.map((e, i) => (i ? e : { ...e, size: CAP + 1 }))),
    ],
    [
      'an entry with no sha256',
      () => pinManifest(ENTRIES.map((e, i) => (i ? e : { ...e, sha256: null }))),
    ],
    [
      'more external entries than file numbers',
      () => pinManifest(Array.from({ length: 100 }, (_, i) => ({ ...ENTRIES[0], path: `f${i}` }))),
    ],
    [
      'a manifest that is not JSON',
      () => {
        const bytes = new TextEncoder().encode('{"entries": [');
        objects.set(MANIFEST_KEY, bytes);
        process.env.PRESERVED_VIEW_MANIFEST_SHA256 = sha(bytes);
      },
    ],
    ['a missing manifest', () => objects.delete(MANIFEST_KEY)],
    [
      'a manifest over 1 MB',
      () => pinManifest([...ENTRIES, { status: 'ok', path: 'pad', pad: 'x'.repeat(1024 * 1024) }]),
    ],
    [
      'an entry from another bucket',
      () =>
        pinManifest(
          ENTRIES.map((e, i) => (i ? e : { ...e, source: { ...e.source, bucket: 'other' } }))
        ),
    ],
  ])('refuses %s with 409, before any audit row', async (_what, arrange) => {
    arrange();
    expect((await get('1')).status).toBe(409);
    expect(insertModActivity).not.toHaveBeenCalled();
  });

  it('answers 502 when the store cannot be read for the manifest', async () => {
    objects.set(MANIFEST_KEY, Object.assign(new Error('boom'), { name: 'InternalError' }));
    expect((await get('1')).status).toBe(502);
    expect(insertModActivity).not.toHaveBeenCalled();
  });

  it.each([
    ['sha256', Uint8Array.from(FILES[0]).map((b, i) => (i === 9 ? b ^ 1 : b)), { sizeMatch: true }],
    ['size', Uint8Array.from([...FILES[0], 0]), { sizeMatch: false }],
    ['size, past the cap', new Uint8Array(CAP + 1), { sizeMatch: false, bytes: null }],
  ])('answers 409 with no body when the stored bytes differ in %s', async (_what, stored, line) => {
    objects.set(FILE_KEYS[0], stored);
    const { status, res } = await get('1');
    expect(status).toBe(409);
    expect(await res!.text()).toBe('');
    expect(serveLine()).toMatchObject({ name: 'preserved-file-serve', n: 1, status: 409, ...line });
    expect(state.order).not.toContain(DELIVERED);
  });

  it.each([
    ['404', undefined, 404],
    ['502', Object.assign(new Error('boom'), { name: 'InternalError' }), 502],
  ])(
    'answers %s for a file the store does not give, and logs it',
    async (_what, stored, status) => {
      if (stored) objects.set(FILE_KEYS[0], stored);
      else objects.delete(FILE_KEYS[0]);
      expect((await get('1')).status).toBe(status);
      expect(serveLine()).toMatchObject({ n: 1, status });
      expect(state.order).not.toContain(DELIVERED);
    }
  );

  it('refuses bytes that are not an image it renders', async () => {
    const text = new TextEncoder().encode('<svg onload=alert(1)>');
    objects.set(FILE_KEYS[0], text);
    pinManifest(ENTRIES.map((e, i) => (i ? e : entry(FILE_KEYS[0], text))));
    const { status, res } = await get('1');
    expect(status).toBe(415);
    expect(await res!.text()).toBe('');
    expect(state.order).not.toContain(DELIVERED);
  });

  it('sends no bytes and never reads the file when the served row is not written', async () => {
    state.failActivity = 'preservedFile:served';
    expect((await get('1')).status).toBe(503);
    expect(fileReads()).toEqual([]);
  });

  it('sends no bytes and never reads the file when the served row does not read back', async () => {
    state.rowExists = false;
    expect((await get('1')).status).toBe(503);
    expect(fileReads()).toEqual([]);
  });

  it('sends no bytes when the delivered row is not written', async () => {
    state.failActivity = 'preservedFile:delivered';
    expect((await get('1')).status).toBe(503);
  });

  it('no longer serves a file that has a verdict', async () => {
    state.verdicts.set(2, 'not');
    expect((await get('2')).status).toBe(410);
    expect(insertModActivity).not.toHaveBeenCalled();
    expect(fileReads()).toEqual([]);
    expect((await get('1')).status).toBe(200);
  });

  it('does not serve a file whose verdict lands while its view is being recorded', async () => {
    state.ruleDuringAudit = 1;
    expect((await get('1')).status).toBe(410);
    expect(fileReads()).toEqual([]);
  });

  it('does not send bytes whose verdict landed while they were read', async () => {
    state.ruleOnRead = 1;
    expect((await get('1')).status).toBe(410);
    expect(state.order).not.toContain(DELIVERED);
  });

  it('refuses a request without the review page header, before any audit row', async () => {
    expect((await get('1', { marker: null })).status).toBe(403);
    expect((await get('1', { marker: '1' })).status).toBe(403);
    expect(insertModActivity).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('logs a serve whose delivered row failed as 503, not 200', async () => {
    state.failActivity = 'preservedFile:delivered';
    expect((await get('1')).status).toBe(503);
    expect(serveLine()).toMatchObject({ n: 1, status: 503 });
  });

  it('answers HEAD without auditing or reading', async () => {
    expect((await get('1', { method: 'HEAD' })).status).toBe(405);
    expect(send).not.toHaveBeenCalled();
    expect(insertModActivity).not.toHaveBeenCalled();
  });
});

describe('who may open it', () => {
  it('refuses a moderator without the page grant', async () => {
    state.grants = new Set();
    expect((await get('1')).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a grant holder who is not on the reviewer list', async () => {
    expect((await get('1', { user: { id: 503, roles: REVIEWER.roles } })).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses an admin, whose grant reaches every page, when not on the reviewer list', async () => {
    expect((await get('1', { user: ADMIN })).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a signed-out request', async () => {
    expect((await get('1', { user: null })).status).toBe(403);
  });

  it.each(Object.keys(ENV))('answers 404 to everyone while %s is unset', async (name) => {
    delete process.env[name];
    expect((await get('1')).status).toBe(404);
    expect((await get('1', { user: ADMIN })).status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it('answers 404 while the reviewer list is malformed', async () => {
    process.env.PRESERVED_VIEW_USER_IDS = `${REVIEWER.id},x`;
    expect((await get('1')).status).toBe(404);
  });
});

describe('the page', () => {
  async function verdict(fields: Record<string, string>, user: unknown = REVIEWER) {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    const request = new Request('http://mod.test/csam/preserved-view?/verdict', {
      method: 'POST',
      body,
    });
    try {
      return (await actions.verdict({ request, locals: { user, grants: {} } } as never)) as
        | { status: number; data: { error: string } }
        | { recorded: number };
    } catch (e) {
      return { status: (e as { status?: number }).status ?? 500, data: { error: 'thrown' } };
    }
  }

  it('lists each file with no storage key or hash', async () => {
    state.delivered = new Set([`${REVIEWER.id}:1`]);
    state.verdicts.set(3, 'apparent');
    const data = (await load({ locals: { user: REVIEWER, grants: {} } } as never)) as {
      files: unknown[];
    };
    expect(data.files).toEqual([
      { n: 1, size: FILES[0].byteLength, verdict: null },
      { n: 2, size: FILES[1].byteLength, verdict: null },
      { n: 3, size: FILES[2].byteLength, verdict: 'apparent' },
    ]);
    expect(insertModActivity).not.toHaveBeenCalled();
    expect(fileReads()).toEqual([]);
  });

  it('records a verdict for a file this reviewer was sent', async () => {
    state.delivered = new Set([`${REVIEWER.id}:1`]);
    expect(await verdict({ n: '1', verdict: 'apparent' })).toEqual({ recorded: 1 });
    expect(recordPreservedVerdict).toHaveBeenCalledTimes(1);
    expect(recordPreservedVerdict).toHaveBeenCalledWith(
      { n: 1, key: FILE_KEYS[0], size: FILES[0].byteLength, sha256: sha(FILES[0]) },
      REVIEWER.id,
      'apparent'
    );
  });

  it('records a verdict after a serve that delivered the bytes', async () => {
    expect((await get('1')).status).toBe(200);
    expect(await verdict({ n: '1', verdict: 'not' })).toEqual({ recorded: 1 });
  });

  it('refuses a verdict on a file another reviewer was sent', async () => {
    expect((await get('1', { user: REVIEWER_2 })).status).toBe(200);
    expect(await verdict({ n: '1', verdict: 'not' })).toMatchObject({ status: 409 });
    expect(recordPreservedVerdict).not.toHaveBeenCalled();
    expect(await verdict({ n: '1', verdict: 'not' }, REVIEWER_2)).toEqual({ recorded: 1 });
  });

  it('refuses a verdict on a file whose serve was refused', async () => {
    objects.set(FILE_KEYS[1], Uint8Array.from([...FILES[1], 0]));
    expect((await get('2')).status).toBe(409);
    expect(await verdict({ n: '2', verdict: 'not' })).toMatchObject({ status: 409 });
    expect(recordPreservedVerdict).not.toHaveBeenCalled();
  });

  it('refuses a second verdict', async () => {
    state.delivered = new Set([`${REVIEWER.id}:1`]);
    recordPreservedVerdict.mockResolvedValueOnce('already');
    expect(await verdict({ n: '1', verdict: 'not' })).toMatchObject({ status: 409 });
  });

  it.each([
    [{ n: '1', verdict: 'maybe' }, 400],
    [{ verdict: 'not' }, 400],
    [{ n: '4', verdict: 'not' }, 404],
  ])('refuses %o with %i', async (fields, status) => {
    state.delivered = new Set([`${REVIEWER.id}:1`, `${REVIEWER.id}:4`]);
    expect(await verdict(fields)).toMatchObject({ status });
    expect(recordPreservedVerdict).not.toHaveBeenCalled();
  });

  it('refuses a verdict from an admin who is not the reviewer', async () => {
    state.delivered = new Set([`${REVIEWER.id}:1`]);
    expect(await verdict({ n: '1', verdict: 'not' }, ADMIN)).toMatchObject({ status: 403 });
    expect(recordPreservedVerdict).not.toHaveBeenCalled();
  });
});

describe('the object store', () => {
  const config = {
    endpoint: 'https://store.test',
    region: 'us-east-1',
    bucket: 'held',
    accessKey: 'k',
    secretKey: 's',
  };

  it('refuses an unlisted key before any request is sent', async () => {
    const store = createPreservedObjectStore(config, (key) => key === FILE_KEYS[0]);
    await expect(store.read(FILE_KEYS[1], 1024)).rejects.toBeInstanceOf(UnlistedKeyError);
    await expect(store.read(MANIFEST_KEY, 1024)).rejects.toBeInstanceOf(UnlistedKeyError);
    expect(send).not.toHaveBeenCalled();
    expect(await store.read(FILE_KEYS[0], 1024)).toEqual(FILES[0]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reads only the keys the verified manifest names', async () => {
    objects.set('fixture/other.png', FILES[0]);
    const opened = await openPreservedFiles(readPreservedViewConfig()!);
    send.mockClear();
    const stray = {
      n: 1,
      key: 'fixture/other.png',
      size: FILES[0].byteLength,
      sha256: sha(FILES[0]),
    };
    await expect(opened.read(stray)).rejects.toBeInstanceOf(UnlistedKeyError);
    expect(send).not.toHaveBeenCalled();
    expect(await opened.read(opened.files[0])).toEqual(FILES[0]);
  });

  it('refuses an object over the cap', async () => {
    const store = createPreservedObjectStore(config, () => true);
    await expect(store.read(FILE_KEYS[0], FILES[0].byteLength - 1)).rejects.toBeInstanceOf(
      OversizeObjectError
    );
  });
});

describe('sniffImageType', () => {
  const bytes = (...parts: (number[] | string)[]) =>
    Uint8Array.from(
      parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p))
    );

  it.each([
    ['image/jpeg', bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF')],
    ['image/png', bytes([0x89], 'PNG', [0x0d, 0x0a])],
    ['image/gif', bytes('GIF89a')],
    ['image/webp', bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')],
  ])('reads %s from its signature', (type, data) => {
    expect(sniffImageType(data)).toBe(type);
  });

  it.each([
    ['svg', bytes('<svg xmlns="http://www.w3.org/2000/svg">')],
    ['a RIFF that is not WEBP', bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt ')],
    ['html', bytes('<!doctype html>')],
  ])('refuses %s', (_what, data) => {
    expect(sniffImageType(data)).toBeNull();
  });
});
