import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PreservedViewModule from '../preserved-view';

/**
 * The preserved-file review: three files from a pinned manifest, served to one named reviewer, each
 * serve audited before the store is called. The store is the real client with `send` stubbed, so the
 * allowlist and the order of calls are what production runs.
 */

const state = vi.hoisted(() => ({
  grants: new Set<string>(),
  verdicts: new Map<number, 'apparent' | 'not'>(),
  served: new Set<number>(),
  insertFails: false,
  rowExists: true,
  order: [] as string[],
}));
const insertModActivity = vi.hoisted(() =>
  vi.fn(async (_row: Record<string, unknown>) => {
    state.order.push('audit');
    if (state.insertFails) throw new Error('db down');
    return 77;
  })
);
const modActivityRowExists = vi.hoisted(() => vi.fn(async (_id: number) => state.rowExists));
const logToAxiom = vi.hoisted(() => vi.fn(async (_line: Record<string, unknown>) => {}));
const recordPreservedVerdict = vi.hoisted(() =>
  vi.fn(
    async (_reviewer: number, _n: number, _verdict: string) => 'recorded' as 'recorded' | 'already'
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
  preservedVerdicts: async () => new Map(state.verdicts),
  servedTo: async () => new Set(state.served),
  recordPreservedVerdict,
}));

const { GET } = await import('../../../routes/api/preserved-view/[n]/+server');
const { actions, load } = await import('../../../routes/csam/preserved-view/+page.server');
const { createPreservedObjectStore, OversizeObjectError, UnlistedKeyError } = await import(
  '../preserved-object-store'
);
const { openPreservedFiles, readPreservedViewConfig } = await import('../preserved-view');

const PAGE = '/csam/preserved-view';
const REVIEWER = { id: 501, roles: ['moderator:preserved-review'] };
const ADMIN = { id: 900, roles: ['moderator:admin'] };
const MANIFEST_KEY = 'fixture/run-1/manifest.json';
const FILE_KEYS = ['fixture/held/a.png', 'fixture/held/b.png', 'fixture/held/c.png'];

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const png = (seed: number) =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, seed + 1, seed + 2]);
const FILES = FILE_KEYS.map((_, i) => png(i * 10));

function manifestBytes(entries: unknown[]) {
  return new TextEncoder().encode(JSON.stringify({ version: 1, run: {}, entries, skipped: [] }));
}
const ENTRIES = FILE_KEYS.map((key, i) => ({
  status: 'external',
  path: `files/${i}`,
  size: FILES[i].byteLength,
  sha256: sha(FILES[i]),
  source: { store: 'held', bucket: 'b', key },
}));
const MANIFEST = manifestBytes(ENTRIES);

const objects = new Map<string, Uint8Array>();
const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: {
  input: { Key: string };
}) => {
  state.order.push(`get:${command.input.Key}`);
  const bytes = objects.get(command.input.Key);
  if (!bytes) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
  return { Body: Readable.from([Buffer.from(bytes)]), ContentLength: bytes.byteLength };
}) as never);
afterAll(() => send.mockRestore());

const ENV = {
  PRESERVED_VIEW_MANIFEST_KEY: MANIFEST_KEY,
  PRESERVED_VIEW_MANIFEST_SHA256: sha(MANIFEST),
  PRESERVED_VIEW_USER_IDS: `${REVIEWER.id}`,
  PRESERVED_VIEW_S3_ENDPOINT: 'https://store.test',
  PRESERVED_VIEW_S3_BUCKET: 'held',
  PRESERVED_VIEW_S3_KEY: 'test-key',
  PRESERVED_VIEW_S3_SECRET: 'test-secret',
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, ENV);
  state.grants = new Set([PAGE]);
  state.verdicts = new Map();
  state.served = new Set();
  state.insertFails = false;
  state.rowExists = true;
  state.order = [];
  objects.clear();
  objects.set(MANIFEST_KEY, MANIFEST);
  FILE_KEYS.forEach((key, i) => objects.set(key, FILES[i]));
});

type Outcome = { status: number; res?: Response };

async function get(
  n: string,
  { search = '', method = 'GET', user = REVIEWER as unknown }: Record<string, unknown> = {}
): Promise<Outcome> {
  const url = new URL(`http://mod.test/api/preserved-view/${n}${search}`);
  try {
    const res = await GET({
      params: { n },
      url,
      request: new Request(url, { method: method as string }),
      locals: { user, grants: {} },
    } as never);
    return { status: res.status, res };
  } catch (e) {
    return { status: (e as { status?: number }).status ?? 500 };
  }
}

const fileReads = () => state.order.filter((step) => FILE_KEYS.some((k) => step === `get:${k}`));

describe('serving a file', () => {
  it('serves the pinned bytes once the audit row is written and read back', async () => {
    const { status, res } = await get('2');
    expect(status).toBe(200);
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(FILES[1]);
    expect(res!.headers.get('content-type')).toBe('image/png');
    expect(res!.headers.get('cache-control')).toBe('private, no-store');
    expect(res!.headers.get('accept-ranges')).toBe('none');
    expect(state.order).toEqual([`get:${MANIFEST_KEY}`, 'audit', `get:${FILE_KEYS[1]}`]);
    expect(modActivityRowExists).toHaveBeenCalledWith(77);
    expect(insertModActivity).toHaveBeenCalledWith({
      userId: REVIEWER.id,
      entityType: 'preservedFile',
      entityId: 2,
      activity: 'preservedFile:served',
      credential: 'web',
    });
  });

  it.each(['0', '4', '-1', '01', '1.0', 'abc', '99'])('refuses file number %s', async (n) => {
    expect((await get(n)).status).toBe(404);
    expect(insertModActivity).not.toHaveBeenCalled();
    expect(fileReads()).toEqual([]);
  });

  it('refuses a request that names a key, before touching the store', async () => {
    expect((await get('1', { search: `?key=${encodeURIComponent(FILE_KEYS[2])}` })).status).toBe(
      404
    );
    expect(send).not.toHaveBeenCalled();
    expect(insertModActivity).not.toHaveBeenCalled();
  });

  it('refuses everything when the manifest does not match its pinned sha256', async () => {
    process.env.PRESERVED_VIEW_MANIFEST_SHA256 = sha(manifestBytes(ENTRIES.slice(0, 2)));
    expect((await get('1')).status).toBe(409);
    expect(state.order).toEqual([`get:${MANIFEST_KEY}`]);
  });

  it('refuses a manifest entry whose hash disagrees with its pinned input', async () => {
    const entries = ENTRIES.map((e, i) =>
      i === 0 ? { ...e, pinned: { size: e.size, sha256: sha(FILES[2]) } } : e
    );
    const manifest = manifestBytes(entries);
    objects.set(MANIFEST_KEY, manifest);
    process.env.PRESERVED_VIEW_MANIFEST_SHA256 = sha(manifest);
    expect((await get('1')).status).toBe(409);
    expect(insertModActivity).not.toHaveBeenCalled();
  });

  it.each([
    ['sha256', Uint8Array.from(FILES[0]).map((b, i) => (i === 9 ? b ^ 1 : b))],
    ['size', Uint8Array.from([...FILES[0], 0])],
  ])('answers 409 with no body when the stored bytes differ in %s', async (what, stored) => {
    objects.set(FILE_KEYS[0], stored);
    const { status, res } = await get('1');
    expect(status).toBe(409);
    expect(await res!.text()).toBe('');
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'preserved-file-serve',
        n: 1,
        status: 409,
        sha256Match: false,
      })
    );
    if (what === 'size') expect(logToAxiom.mock.calls[0][0].sizeMatch).toBe(false);
  });

  it('refuses bytes that are not an image it renders', async () => {
    const text = new TextEncoder().encode('<svg onload=alert(1)>');
    const entries = ENTRIES.map((e, i) =>
      i === 0 ? { ...e, size: text.byteLength, sha256: sha(text) } : e
    );
    const manifest = manifestBytes(entries);
    objects.set(MANIFEST_KEY, manifest);
    objects.set(FILE_KEYS[0], text);
    process.env.PRESERVED_VIEW_MANIFEST_SHA256 = sha(manifest);
    const { status, res } = await get('1');
    expect(status).toBe(415);
    expect(await res!.text()).toBe('');
  });

  it('sends no bytes and never reads the file when the audit row is not written', async () => {
    state.insertFails = true;
    expect((await get('1')).status).toBe(503);
    expect(fileReads()).toEqual([]);
  });

  it('sends no bytes and never reads the file when the audit row does not read back', async () => {
    state.rowExists = false;
    expect((await get('1')).status).toBe(503);
    expect(fileReads()).toEqual([]);
  });

  it('no longer serves a file that has a verdict', async () => {
    state.verdicts.set(2, 'not');
    expect((await get('2')).status).toBe(410);
    expect(insertModActivity).not.toHaveBeenCalled();
    expect(fileReads()).toEqual([]);
    expect((await get('1')).status).toBe(200);
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
    expect((await get('1', { user: { id: 502, roles: REVIEWER.roles } })).status).toBe(403);
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

  it('lists each file with no storage key', async () => {
    state.served = new Set([1]);
    state.verdicts.set(3, 'apparent');
    const data = (await load({ locals: { user: REVIEWER, grants: {} } } as never)) as {
      files: unknown[];
    };
    expect(data.files).toEqual([
      { n: 1, size: FILES[0].byteLength, verdict: null, viewed: true },
      { n: 2, size: FILES[1].byteLength, verdict: null, viewed: false },
      { n: 3, size: FILES[2].byteLength, verdict: 'apparent', viewed: false },
    ]);
    expect(insertModActivity).not.toHaveBeenCalled();
    expect(fileReads()).toEqual([]);
  });

  it('records a verdict for a file this reviewer was served', async () => {
    state.served = new Set([1]);
    expect(await verdict({ n: '1', verdict: 'apparent' })).toEqual({ recorded: 1 });
    expect(recordPreservedVerdict).toHaveBeenCalledWith(REVIEWER.id, 1, 'apparent');
  });

  it('refuses a verdict on a file this reviewer has not opened', async () => {
    expect(await verdict({ n: '2', verdict: 'not' })).toMatchObject({ status: 409 });
    expect(recordPreservedVerdict).not.toHaveBeenCalled();
  });

  it('refuses a second verdict', async () => {
    state.served = new Set([1]);
    recordPreservedVerdict.mockResolvedValueOnce('already');
    expect(await verdict({ n: '1', verdict: 'not' })).toMatchObject({ status: 409 });
  });

  it.each([[{ n: '1', verdict: 'maybe' }], [{ n: '4', verdict: 'not' }], [{ verdict: 'not' }]])(
    'refuses %o',
    async (fields) => {
      state.served = new Set([1, 4]);
      expect(await verdict(fields)).toMatchObject({ status: expect.any(Number) });
      expect(recordPreservedVerdict).not.toHaveBeenCalled();
    }
  );

  it('refuses a verdict from an admin who is not the reviewer', async () => {
    state.served = new Set([1]);
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
