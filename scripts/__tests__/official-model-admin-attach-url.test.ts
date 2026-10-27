import { describe, expect, it, vi } from 'vitest';

const { attachUrl, detachUrl, sameObjectKey } = await import(
  '../../.claude/skills/official-model-admin/attach-url.mjs'
);

const SOURCE_URL =
  'https://civitai-prod-settled.abcd.r2.cloudflarestorage.com/model/1/remacri.safetensors';
const SOURCE = {
  id: 11,
  name: 'remacri.safetensors',
  url: SOURCE_URL,
  sizeKB: 64,
  type: 'Model',
  metadata: { format: 'SafeTensor' },
};
const WEIGHTS = Buffer.alloc(64 * 1024, 7);

type Files = Record<number, { id: number; url?: string; [k: string]: unknown }[]>;

// Downloads answer by (version, file) the way the site's resolve does: a file row with no stored
// object behind it is a 404, whatever its url says.
function setup({
  files,
  stored,
  lagging = 0,
  cached = {},
  storageHost = 'storage.test',
}: {
  files: Files;
  stored: Record<string, Buffer>;
  lagging?: number;
  /** What the cached file list says, where it has not caught up with `files`. */
  cached?: Files;
  storageHost?: string;
}) {
  let lagLeft = lagging;
  const call = vi.fn(async (procedure: string, input: Record<string, unknown>) => {
    const id = input.id as number;
    if (procedure === 'modelFile.getByVersionId') return { files: cached[id] ?? files[id] ?? [] };
    if (procedure === 'modelVersion.getByIdForEdit') return { id, files: files[id] ?? [] };
    if (procedure === 'modelFile.create') {
      const created = { id: 99, ...input };
      (files[input.modelVersionId as number] ??= []).push(created);
      return created;
    }
    if (procedure === 'modelFile.delete') return {};
    throw new Error(`unexpected ${procedure}`);
  });
  // The download route redirects to the storage host, which serves the bytes.
  const fetchFn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    const { host, pathname, searchParams } = new URL(url);
    if (host === 'civitai.test') {
      const key = `${pathname.split('/').pop()}:${searchParams.get('fileId')}`;
      const lagged = key.endsWith(':99') && lagLeft-- > 0;
      if (!stored[key] || lagged) return new Response('File not found', { status: 404 });
      return new Response(null, {
        status: 307,
        headers: { location: `https://${storageHost}/${key}` },
      });
    }
    const bytes = stored[pathname.slice(1)];
    return new Response(bytes, {
      status: 206,
      headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` },
    });
  });
  const lines: string[] = [];
  const deps = {
    call,
    fetchFn,
    apiUrl: 'https://civitai.test',
    apiKey: 'k',
    log: (l: string) => lines.push(l),
    sleep: async () => undefined,
  };
  const created = () => call.mock.calls.filter(([p]) => p === 'modelFile.create');
  return { call, fetchFn, deps, lines, created };
}

const opts = { fromFile: 11, fromVersion: 100, version: 200 };

describe('attach-url', () => {
  it('dry run reads the source and its download, and creates nothing', async () => {
    const t = setup({ files: { 100: [SOURCE] }, stored: { '100:11': WEIGHTS } });
    expect(await attachUrl({ ...opts, writable: false }, t.deps)).toBe(true);
    expect(t.lines.join('\n')).toContain('served from storage.test');
    expect(t.created()).toHaveLength(0);
    expect(t.fetchFn).toHaveBeenCalledTimes(2);
    expect(t.lines.join('\n')).toContain(SOURCE_URL);
  });

  it('creates a file on the target with the source url and verifies it downloads the same bytes', async () => {
    const t = setup({
      files: { 100: [SOURCE] },
      stored: { '100:11': WEIGHTS, '200:99': WEIGHTS },
    });
    expect(await attachUrl({ ...opts, writable: true }, t.deps)).toBe(true);
    expect(t.created()[0][1]).toEqual({
      modelVersionId: 200,
      name: SOURCE.name,
      url: SOURCE_URL,
      sizeKB: 64,
      type: 'Model',
      metadata: { format: 'SafeTensor' },
    });
    expect(t.lines.join('\n')).toContain('VERIFIED');
  });

  it('never sends the API key to the storage host it is redirected to', async () => {
    const t = setup({
      files: { 100: [SOURCE] },
      stored: { '100:11': WEIGHTS, '200:99': WEIGHTS },
    });
    expect(await attachUrl({ ...opts, writable: true }, t.deps)).toBe(true);
    const storageCalls = t.fetchFn.mock.calls.filter(([u]) =>
      u.startsWith('https://storage.test/')
    );
    expect(storageCalls).toHaveLength(2);
    for (const [, init] of storageCalls) expect(init?.headers).not.toHaveProperty('Authorization');
  });

  it('verifies a new file that 404s at first while the read replica catches up', async () => {
    const t = setup({
      files: { 100: [SOURCE] },
      stored: { '100:11': WEIGHTS, '200:99': WEIGHTS },
      lagging: 2,
    });
    expect(await attachUrl({ ...opts, writable: true }, t.deps)).toBe(true);
  });

  it('fails and prints the undo when the new file does not download', async () => {
    const t = setup({ files: { 100: [SOURCE] }, stored: { '100:11': WEIGHTS } });
    expect(await attachUrl({ ...opts, writable: true }, t.deps)).toBe(false);
    expect(t.lines.join('\n')).toMatch(/NOT VERIFIED[\s\S]*detach-url --file 99 --version 200/);
  });

  it('fails when the new file downloads different bytes', async () => {
    const t = setup({
      files: { 100: [SOURCE] },
      stored: { '100:11': WEIGHTS, '200:99': Buffer.alloc(64 * 1024, 8) },
    });
    expect(await attachUrl({ ...opts, writable: true }, t.deps)).toBe(false);
  });

  it('refuses a source whose url the API withheld (not a moderator key)', async () => {
    const { url: _url, ...hidden } = SOURCE;
    const t = setup({ files: { 100: [hidden] }, stored: { '100:11': WEIGHTS } });
    expect(await attachUrl({ ...opts, writable: true }, t.deps)).toBe(false);
    expect(t.created()).toHaveLength(0);
    expect(t.fetchFn).not.toHaveBeenCalled();
  });

  it('stops before creating when the source itself does not download', async () => {
    const t = setup({ files: { 100: [SOURCE] }, stored: {} });
    expect(await attachUrl({ ...opts, writable: true }, t.deps)).toBe(false);
    expect(t.created()).toHaveLength(0);
  });

  it('stops before creating when the source is served from B2 under an R2 url', async () => {
    const t = setup({
      files: { 100: [SOURCE] },
      stored: { '100:11': WEIGHTS, '200:99': WEIGHTS },
      storageHost: 'b2.civitai.test',
    });
    expect(await attachUrl({ ...opts, writable: true }, t.deps)).toBe(false);
    expect(t.created()).toHaveLength(0);
    expect(t.lines.join('\n')).toContain('served from B2');
  });

  it('does not create a second file when the cached file list has not caught up', async () => {
    const t = setup({
      files: { 100: [SOURCE], 200: [{ id: 55, url: SOURCE_URL }] },
      cached: { 200: [] },
      stored: { '100:11': WEIGHTS, '200:55': WEIGHTS },
    });
    expect(await attachUrl({ ...opts, writable: true }, t.deps)).toBe(true);
    expect(t.created()).toHaveLength(0);
  });

  it('refuses a --url that names a different object', async () => {
    const t = setup({ files: { 100: [SOURCE] }, stored: { '100:11': WEIGHTS } });
    const url =
      'https://s3.us-west-004.backblazeb2.com/civitai-modelfiles/model/1/other.safetensors';
    expect(await attachUrl({ ...opts, url, writable: true }, t.deps)).toBe(false);
    expect(t.created()).toHaveLength(0);
  });

  it('does not create a second file when the target already has the url', async () => {
    const t = setup({
      files: { 100: [SOURCE], 200: [{ id: 55, url: SOURCE_URL }] },
      stored: { '100:11': WEIGHTS, '200:55': WEIGHTS },
    });
    expect(await attachUrl({ ...opts, writable: true }, t.deps)).toBe(true);
    expect(t.created()).toHaveLength(0);
  });
});

describe('sameObjectKey', () => {
  it('matches the same key in virtual-host and path-style urls, on either store', () => {
    expect(
      sameObjectKey(
        SOURCE_URL,
        'https://s3.us-west-004.backblazeb2.com/civitai-modelfiles/model/1/remacri.safetensors'
      )
    ).toBe(true);
    expect(sameObjectKey(SOURCE_URL, SOURCE_URL.replace('remacri', 'other'))).toBe(false);
  });
});

describe('detach-url', () => {
  const dOpts = { file: 99, version: 200, fromFile: 11, fromVersion: 100, writable: true };

  it('deletes a file that shares the source url', async () => {
    const t = setup({ files: { 100: [SOURCE], 200: [{ id: 99, url: SOURCE_URL }] }, stored: {} });
    expect(await detachUrl(dOpts, t.deps)).toBe(true);
    expect(t.call).toHaveBeenCalledWith('modelFile.delete', { id: 99 });
  });

  it('finds a file the cached file list does not show yet', async () => {
    const t = setup({
      files: { 100: [SOURCE], 200: [{ id: 99, url: SOURCE_URL }] },
      cached: { 200: [] },
      stored: {},
    });
    expect(await detachUrl(dOpts, t.deps)).toBe(true);
    expect(t.call).toHaveBeenCalledWith('modelFile.delete', { id: 99 });
  });

  it('refuses a file whose url differs from the source, since its delete could free the object', async () => {
    const t = setup({
      files: { 100: [SOURCE], 200: [{ id: 99, url: SOURCE_URL.replace('settled', 'other') }] },
      stored: {},
    });
    expect(await detachUrl(dOpts, t.deps)).toBe(false);
    expect(t.call).not.toHaveBeenCalledWith('modelFile.delete', expect.anything());
  });
});
