import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_ERRORS_ENDPOINT,
  createPreviewErrorReporter,
  parseBlockErrorReport,
} from '~/components/AppBlocks/devPreviewErrors';

/**
 * The live dev preview's error reporter (`devPreviewErrors.ts`): what it reads of a `BLOCK_ERROR`,
 * how it batches, and — the seam — that ONLY the dev-tunnel host hands the page host an
 * `onBlockError`, so a production mount reports nothing new.
 */

describe('parseBlockErrorReport', () => {
  it('reads the SDK’s report, checking each field', () => {
    expect(
      parseBlockErrorReport({
        message: 'boom',
        fatal: false,
        source: 'unhandledrejection',
        stack: 'at x',
        at: 1_700_000_000_000,
      })
    ).toEqual({
      message: 'boom',
      fatal: false,
      source: 'unhandledrejection',
      stack: 'at x',
      at: 1_700_000_000_000,
    });
  });

  it('reads an old SDK’s bare report, and drops what is not a report', () => {
    expect(parseBlockErrorReport({ message: 'boom', fatal: true }, 42)).toEqual({
      message: 'boom',
      fatal: true,
      at: 42,
    });
    expect(
      parseBlockErrorReport({ message: 'x', source: 'eval', stack: 7, at: 'soon' }, 9)
    ).toEqual({ message: 'x', fatal: false, at: 9 });
    for (const raw of [null, 'boom', {}, { message: '' }, { message: '   ' }, { message: 3 }])
      expect(parseBlockErrorReport(raw)).toBeNull();
  });

  it('caps the message at 2,000 and the stack at 4,000 characters', () => {
    const out = parseBlockErrorReport({ message: 'm'.repeat(2500), stack: 's'.repeat(4500) });
    expect(out?.message).toHaveLength(2000);
    expect(out?.stack).toHaveLength(4000);
  });
});

describe('createPreviewErrorReporter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const reporter = () => {
    const posts: {
      url: string;
      body: { blockId: string; errors: unknown[] };
      keepalive?: boolean;
    }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      posts.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        keepalive: init?.keepalive,
      });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    return {
      posts,
      r: createPreviewErrorReporter({ blockId: 'slideshow', fetchImpl, flushMs: 100 }),
    };
  };

  it('sends what arrives within the wait as one batch, for its app', async () => {
    const { posts, r } = reporter();
    r.report({ message: 'a', at: 1 });
    r.report({ message: 'b', at: 2 });
    r.report({ nope: true });
    expect(posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(PREVIEW_ERRORS_ENDPOINT);
    expect(PREVIEW_ERRORS_ENDPOINT).toBe('/api/apps/dev/preview-errors');
    expect(posts[0]!.body).toEqual({
      blockId: 'slideshow',
      errors: [
        { message: 'a', fatal: false, at: 1 },
        { message: 'b', fatal: false, at: 2 },
      ],
    });
  });

  it('splits a burst into batches of 20 and keeps at most the newest 60', async () => {
    const { posts, r } = reporter();
    for (let i = 0; i < 75; i++) r.report({ message: `e${i}`, at: i });
    await vi.advanceTimersByTimeAsync(100);
    expect(posts.map((p) => p.body.errors.length)).toEqual([20, 20, 20]);
    expect((posts[0]!.body.errors[0] as { message: string }).message).toBe('e15');
  });

  it('sends what is waiting on close, with keepalive, and nothing after', async () => {
    const { posts, r } = reporter();
    r.report({ message: 'last' });
    r.close();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.keepalive).toBe(true);
    r.report({ message: 'after' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(posts).toHaveLength(1);
  });
});

describe('who reports a block’s errors', () => {
  const SRC = path.resolve(__dirname, '../../..');
  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '__tests__') sources(full, out);
      } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  const mounters = sources(SRC)
    .filter((file) => /<PageBlockHost\b/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC, file));

  it('finds the page host’s mounters (the control: the walk sees production ones too)', () => {
    expect(mounters).toContain('components/AppBlocks/DevTunnelBlockHost.tsx');
    expect(mounters.length).toBeGreaterThan(1);
  });

  it('only the dev-tunnel host passes onBlockError: a production mount reports nothing new', () => {
    const reporting = mounters.filter((file) =>
      /\bonBlockError=/.test(fs.readFileSync(path.join(SRC, file), 'utf8'))
    );
    expect(reporting).toEqual(['components/AppBlocks/DevTunnelBlockHost.tsx']);
  });
});
