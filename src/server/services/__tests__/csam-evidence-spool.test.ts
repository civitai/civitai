import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import JSZip from 'jszip';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SPOOL_ENTRIES_PER_REPORT,
  SpoolLimitError,
  skippedEntries,
  spoolBudget,
  spooledFile,
  spoolUrl,
  spoolZip,
} from '~/server/services/csam-evidence-spool';

/** A send's files go to disk as they stream in, counted on the bytes that actually arrive. */

const CAP = 1024 * 1024;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'csam-spool-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function zipFile(name: string, entries: Record<string, Buffer | string>) {
  const zip = new JSZip();
  for (const [entry, bytes] of Object.entries(entries)) zip.file(entry, bytes);
  const file = join(dir, name);
  writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return file;
}

/** The zip with its named entry's compressed bytes overwritten, so that entry no longer inflates. */
function corrupt(file: string, entry: string) {
  const bytes = readFileSync(file);
  const at = bytes.indexOf(Buffer.from(entry)) + entry.length;
  bytes.fill(0xff, at, at + 8);
  writeFileSync(file, bytes);
  return file;
}

const written = (out: string) =>
  readdirSync(out).reduce((n, name) => n + statSync(join(out, name)).size, 0);

describe('a zip', () => {
  it('stops inflating an entry that compresses to almost nothing at the cap', async () => {
    const bomb = await zipFile('bomb.zip', { 'bomb.png': Buffer.alloc(32 * CAP) });
    expect(statSync(bomb).size).toBeLessThan(CAP / 16);
    const out = mkdtempSync(join(dir, 'out-'));
    const budget = spoolBudget(CAP);

    await expect(spoolZip(bomb, out, budget)).rejects.toBeInstanceOf(SpoolLimitError);

    // One chunk past the cap at most, never the entry.
    expect(budget.used).toBeLessThan(2 * CAP);
    expect(written(out)).toBeLessThanOrEqual(CAP);
  });

  it('stops a single entry past the per-file cap, under the report cap', async () => {
    const zip = await zipFile('one.zip', { 'one.png': Buffer.alloc(CAP / 2 + 1) });

    await expect(
      spoolZip(zip, mkdtempSync(join(dir, 'out-')), spoolBudget(4 * CAP, CAP / 2))
    ).rejects.toThrow('a file passes');
  });

  it('counts every zip of one report against the one cap', async () => {
    const half = Buffer.alloc(CAP / 2 + 1, 1);
    const budget = spoolBudget(CAP);

    await spoolZip(await zipFile('a.zip', { 'a.png': half }), mkdtempSync(join(dir, 'a-')), budget);
    await expect(
      spoolZip(await zipFile('b.zip', { 'b.png': half }), mkdtempSync(join(dir, 'b-')), budget)
    ).rejects.toBeInstanceOf(SpoolLimitError);
  });

  it("keeps only its images and videos, each under a name of the send's own", async () => {
    const out = mkdtempSync(join(dir, 'out-'));
    const zip = await zipFile('mixed.zip', {
      'a.png': 'png bytes',
      'notes.txt': 'not media',
      '__MACOSX/a.png': 'resource fork',
      'nested/dir/b.jpg': 'jpg bytes',
    });

    const files = await spoolZip(zip, out, spoolBudget(CAP));

    expect(files.map(({ filename }) => filename)).toEqual(['a.png', 'nested/dir/b.jpg']);
    expect(readdirSync(out).sort()).toEqual(['entry-0', 'entry-1']);
    expect(readFileSync(files[1].path, 'utf8')).toBe('jpg bytes');
    expect(Buffer.from(await (await spooledFile(files[0])).arrayBuffer()).toString()).toBe(
      'png bytes'
    );
  });
});

describe("a zip's entries", () => {
  it('are kept under names yauzl would refuse, which never reach the file system', async () => {
    const out = mkdtempSync(join(dir, 'out-'));
    const zip = await zipFile('names.zip', {
      '../x.txt': 'not media',
      '/abs.jpg': 'abs bytes',
      'C:\\y.jpg': 'drive bytes',
      'ok.png': 'png bytes',
    });

    const files = await spoolZip(zip, out, spoolBudget(CAP));

    expect(files.map(({ filename }) => filename)).toEqual(['/abs.jpg', 'C:/y.jpg', 'ok.png']);
    expect(readdirSync(out).sort()).toEqual(['entry-0', 'entry-1', 'entry-2']);
    expect(readFileSync(files[2].path, 'utf8')).toBe('png bytes');
  });

  it('skip and record one that is empty or does not inflate, and keep the rest', async () => {
    const out = mkdtempSync(join(dir, 'out-'));
    const zip = corrupt(
      await zipFile('mixed.zip', {
        'empty.png': '',
        'broken.png': Buffer.alloc(4096, 7),
        'ok.png': 'png bytes',
      }),
      'broken.png'
    );
    const budget = spoolBudget(CAP);

    const files = await spoolZip(zip, out, budget);

    expect(files.map(({ filename }) => filename)).toEqual(['ok.png']);
    expect(readdirSync(out)).toEqual(['entry-0']);
    expect(skippedEntries(budget)).toMatchObject({
      count: 2,
      empty: 1,
      unreadable: 1,
      examples: [
        { name: 'empty.png', reason: 'empty' },
        { name: 'broken.png', reason: 'unreadable', error: expect.any(String) },
      ],
    });
  });

  it('fail the report past the entry cap, counted across its zips', async () => {
    const half = Object.fromEntries(
      Array.from({ length: MAX_SPOOL_ENTRIES_PER_REPORT / 2 }, (_, i) => [`${i}.png`, ''])
    );
    const budget = spoolBudget(CAP);

    await spoolZip(await zipFile('a.zip', half), mkdtempSync(join(dir, 'a-')), budget);
    await expect(
      spoolZip(
        await zipFile('b.zip', { ...half, 'one-more.png': 'x' }),
        mkdtempSync(join(dir, 'b-')),
        budget
      )
    ).rejects.toThrow(`more than ${MAX_SPOOL_ENTRIES_PER_REPORT} files`);
  });
});

describe('a URL', () => {
  const serve = (response: Response) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

  it('is cut at the cap, however much more it sends', async () => {
    serve(new Response(new Blob([Buffer.alloc(4 * CAP)]).stream()));
    const file = join(dir, 'big');

    await expect(
      spoolUrl('https://example.invalid/x.png', file, spoolBudget(CAP))
    ).rejects.toBeInstanceOf(SpoolLimitError);
    expect(statSync(file).size).toBeLessThanOrEqual(CAP);
  });

  it('is no file when it answers with an error', async () => {
    serve(new Response('not found', { status: 404 }));

    expect(
      await spoolUrl('https://example.invalid/x.png', join(dir, 'x'), spoolBudget(CAP))
    ).toBeNull();
  });

  it('is typed as the response says, or by its extension where storage says nothing useful', async () => {
    serve(new Response('png', { headers: { 'content-type': 'image/png; charset=binary' } }));
    expect(await spoolUrl('https://example.invalid/a', join(dir, 'a'), spoolBudget(CAP))).toEqual({
      type: 'image/png',
    });

    serve(new Response('mp4', { headers: { 'content-type': 'application/octet-stream' } }));
    expect(
      await spoolUrl('https://example.invalid/b.mp4', join(dir, 'b'), spoolBudget(CAP))
    ).toEqual({ type: 'video/mp4' });
  });
});
