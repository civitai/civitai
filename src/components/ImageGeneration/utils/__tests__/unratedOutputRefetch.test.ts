import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UNRATED_RETRY_MAX_MS,
  UNRATED_RETRY_MIN_MS,
  applyCachedOutputRating,
  createUnratedOutputWatcher,
  readBlobVerdict,
  readCachedGeneratorWorkflows,
  selectUnratedOutputs,
  type BlobVerdict,
} from '~/components/ImageGeneration/utils/unratedOutputRefetch';
import { trpc } from '~/utils/trpc';

const workflow = (id: string, output: Array<Record<string, unknown>>) => ({
  id,
  steps: [{ output }],
});
const image = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  url: `https://orchestrator/v2/consumer/blobs/${id}`,
  type: 'image',
  available: true,
  ...over,
});

describe('selectUnratedOutputs', () => {
  const select = (...args: Parameters<typeof selectUnratedOutputs>) => [
    ...selectUnratedOutputs(...args).keys(),
  ];

  it('picks an available output with no rating', () => {
    expect(
      select([workflow('wf-1', [image('a')]), workflow('wf-2', [image('b', { nsfwLevel: 'r' })])])
    ).toEqual(['a']);
  });

  it('ignores outputs that are rated, blocked, not yet available, or never rated', () => {
    expect(
      select([
        workflow('rated', [image('a', { nsfwLevel: 'pg' })]),
        workflow('blocked', [image('b', { blockedReason: 'NSFWLevel' })]),
        workflow('pending', [image('c', { available: false })]),
        workflow('audio', [image('d', { type: 'audio' })]),
        workflow('mesh', [image('e', { type: 'model3d', format: 'glb' } as never)]),
        workflow('unscanned', [image('f', { type: 'video', nsfwLevel: 'na' })]),
      ])
    ).toEqual([]);
  });

  it('includes an unrated video', () => {
    expect(select([workflow('wf-1', [image('a', { type: 'video' })])])).toEqual(['a']);
  });

  it('skips unrated video from an engine the orchestrator never rates, as WorkflowData does', () => {
    const kling = { params: { ecosystem: 'Kling' } };
    const video = (id: string) => [image(id, { type: 'video' })];
    expect(
      select([
        { id: 'wf-level', metadata: kling, steps: [{ $type: 'videoGen', output: video('a') }] },
        { id: 'step-level', steps: [{ $type: 'videoGen', metadata: kling, output: video('b') }] },
        { id: 'image', steps: [{ $type: 'videoGen', metadata: kling, output: [image('c')] }] },
        { id: 'upscale', steps: [{ $type: 'videoUpscaler', metadata: kling, output: video('d') }] },
        {
          id: 'own-params',
          metadata: kling,
          steps: [{ $type: 'videoGen', metadata: { params: { prompt: 'x' } }, output: video('e') }],
        },
      ])
    ).toEqual(['c', 'd', 'e']);
  });
});

describe('createUnratedOutputWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(readVerdict: (url: string) => Promise<BlobVerdict>) {
    let workflows = [workflow('wf-1', [image('a')])];
    const applyRating = vi.fn((id: string, nsfwLevel: string) => {
      workflows = [workflow('wf-1', [image(id, { nsfwLevel })])];
    });
    const refetch = vi.fn<(ids: string[]) => Promise<void>>(async () => undefined);
    const verdict = vi.fn(readVerdict);
    const watch = createUnratedOutputWatcher({
      readWorkflows: () => workflows,
      readVerdict: verdict,
      applyRating,
      refetch,
    });
    return {
      watch,
      verdict,
      applyRating,
      refetch,
      setWorkflows: (next: typeof workflows) => (workflows = next),
    };
  }

  it('shows the rating as soon as the blob answers, without re-reading the workflow', async () => {
    const { watch, applyRating, refetch } = setup(async () => ({ nsfwLevel: 'r' }));
    watch();
    await vi.advanceTimersByTimeAsync(0);

    expect(applyRating).toHaveBeenCalledWith('a', 'r');
    expect(refetch).not.toHaveBeenCalled();
  });

  it('asks again after a failed scan, which is what makes the orchestrator rescan it', async () => {
    let calls = 0;
    const { watch, verdict, applyRating } = setup(async () => {
      if (++calls < 3) throw new Error('503');
      return { nsfwLevel: 'pg' };
    });
    watch();
    await vi.advanceTimersByTimeAsync(UNRATED_RETRY_MIN_MS * 3);

    expect(verdict).toHaveBeenCalledTimes(3);
    expect(applyRating).toHaveBeenCalledWith('a', 'pg');
  });

  it('backs off on quick failures but reconnects soon after a long wait is cut off', async () => {
    const start = Date.now();
    const at: number[] = [];
    const { watch } = setup(async () => {
      at.push(Date.now() - start);
      if (at.length === 3) await new Promise((resolve) => setTimeout(resolve, 120_000));
      throw new Error('connection reset');
    });
    watch();
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 120_000 + 2_000);

    expect(at).toEqual([0, 2_000, 6_000, 128_000]);
  });

  it('re-reads the workflow when the blob answers blocked', async () => {
    const { watch, applyRating, refetch } = setup(async () => ({
      nsfwLevel: 'xxx',
      blockedReason: 'NSFWLevel',
    }));
    watch();
    await vi.advanceTimersByTimeAsync(0);

    expect(refetch).toHaveBeenCalledWith(['wf-1']);
    expect(applyRating).not.toHaveBeenCalled();
  });

  it('stops asking once the output is no longer waiting on a rating', async () => {
    const { watch, verdict, setWorkflows } = setup(async () => {
      throw new Error('503');
    });
    watch();
    await vi.advanceTimersByTimeAsync(0);
    setWorkflows([]);
    await vi.advanceTimersByTimeAsync(UNRATED_RETRY_MIN_MS * 10);

    expect(verdict).toHaveBeenCalledTimes(1);
  });

  it('keeps one request per output however often it is asked', async () => {
    const { watch, verdict } = setup(() => new Promise<BlobVerdict>(() => undefined));
    watch();
    watch();
    watch();

    expect(verdict).toHaveBeenCalledTimes(1);
  });

  it('re-reads the workflow while the blob has no verdict, since the workflow can be rated first', async () => {
    const { watch, verdict, refetch, setWorkflows } = setup(async () => {
      throw new Error('503');
    });
    refetch.mockImplementation(async () => {
      setWorkflows([workflow('wf-1', [image('a', { nsfwLevel: 'pg' })])]);
    });
    watch();
    await vi.advanceTimersByTimeAsync(UNRATED_RETRY_MIN_MS);

    expect(refetch).toHaveBeenCalledWith(['wf-1']);
    await vi.advanceTimersByTimeAsync(UNRATED_RETRY_MAX_MS * 2);
    expect(verdict).toHaveBeenCalledTimes(2);
  });

  it('shares one workflow refetch between that workflow’s outputs', async () => {
    const workflows = [workflow('wf-1', [image('a'), image('b')])];
    const refetch = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 1_000)));
    const watch = createUnratedOutputWatcher({
      readWorkflows: () => workflows,
      readVerdict: async () => {
        throw new Error('503');
      },
      applyRating: vi.fn(),
      refetch,
    });
    watch();
    await vi.advanceTimersByTimeAsync(UNRATED_RETRY_MIN_MS);

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  // `watch()` runs on every change to the cached generator lists, and the refetch below is one.
  async function watchAfterCacheChanges(watch: () => void, times: number) {
    for (let i = 0; i < times; i++) {
      watch();
      await vi.advanceTimersByTimeAsync(UNRATED_RETRY_MIN_MS);
    }
  }

  // Regression: a blocked verdict whose workflow still read unrated restarted on every cache
  // change, one blob HEAD and one workflow refetch every few seconds for as long as the tab lived.
  it('re-reads the workflow once for a blocked verdict, even if the workflow still reads unrated', async () => {
    const { watch, verdict, refetch } = setup(async () => ({
      nsfwLevel: 'xxx',
      blockedReason: 'NSFWLevel',
    }));
    watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(refetch).toHaveBeenCalledTimes(1);

    await watchAfterCacheChanges(watch, 5);

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(verdict).toHaveBeenCalledTimes(1);
  });

  // A tab left open must not poll forever for an output that is never rated, but an outage can
  // outlast one watch, and only a blob read makes the orchestrator rescan a failed scan.
  it('gives up after ten minutes, watches once more after a ten-minute cooldown, then stops for good', async () => {
    const { watch, verdict } = setup(async () => {
      throw new Error('503');
    });
    const start = Date.now();
    const at = (seconds: number) =>
      vi.advanceTimersByTimeAsync(start + seconds * 1000 - Date.now());

    // Reads at 0, 2, 6, 14, 30, 62s, then once a minute; the 602s read is the last.
    watch();
    await at(660);
    expect(verdict).toHaveBeenCalledTimes(15);

    // Cache changes inside the cooldown (which ends at 602 + 600 = 1202s) start nothing.
    await watchAfterCacheChanges(watch, 5);
    await at(1190);
    await watchAfterCacheChanges(watch, 5);
    expect(verdict).toHaveBeenCalledTimes(15);

    // After it, one new watch reads the blob again, and gives up ten minutes later.
    await at(1210);
    watch();
    expect(verdict).toHaveBeenCalledTimes(16);
    await at(1900);
    expect(verdict).toHaveBeenCalledTimes(30);

    // After the second give-up, no cache change ever restarts it.
    await at(1900 + 3600);
    await watchAfterCacheChanges(watch, 5);
    expect(verdict).toHaveBeenCalledTimes(30);
  });

  it('watches a rated output again if the cache later shows it unrated', async () => {
    const { watch, verdict, refetch, setWorkflows } = setup(async () => ({ nsfwLevel: 'r' }));
    watch();
    await vi.advanceTimersByTimeAsync(0);
    await watchAfterCacheChanges(watch, 3);
    expect(verdict).toHaveBeenCalledTimes(1);

    setWorkflows([workflow('wf-1', [image('a')])]);
    await watchAfterCacheChanges(watch, 1);

    expect(verdict).toHaveBeenCalledTimes(2);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('still watches a new output of a workflow whose blocked output was settled', async () => {
    const { watch, verdict, setWorkflows } = setup(async (url) =>
      url.endsWith('/a') ? { nsfwLevel: 'xxx', blockedReason: 'NSFWLevel' } : { nsfwLevel: 'pg' }
    );
    watch();
    await vi.advanceTimersByTimeAsync(0);

    setWorkflows([workflow('wf-1', [image('a'), image('b')])]);
    await watchAfterCacheChanges(watch, 2);

    expect(verdict.mock.calls.map(([url]) => url)).toEqual([
      'https://orchestrator/v2/consumer/blobs/a',
      'https://orchestrator/v2/consumer/blobs/b',
    ]);
  });
});

describe('readBlobVerdict', () => {
  const respond = (status: number, headers: Record<string, string> = {}) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status, headers }));
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the rating the orchestrator sends once the blob is scanned', async () => {
    respond(204, { 'X-NSFW-Level': 'PG13' });
    await expect(readBlobVerdict('https://orchestrator/blob')).resolves.toEqual({
      nsfwLevel: 'pg13',
      blockedReason: undefined,
    });
  });

  it('fails on a failed scan, and on an older orchestrator that answers before the verdict', async () => {
    respond(503);
    await expect(readBlobVerdict('https://orchestrator/blob')).rejects.toThrow();
    respond(204, { 'X-Scan-Status': 'Pending' });
    await expect(readBlobVerdict('https://orchestrator/blob')).rejects.toThrow();
  });
});

describe('applyCachedOutputRating', () => {
  it('rates the output in every cached generator list', () => {
    const client = new QueryClient();
    const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);
    const page = { items: [workflow('wf-1', [image('a'), image('b')])] };
    client.setQueryData([...queryKey, { input: { ascending: false } }], { pages: [page] });
    client.setQueryData([...queryKey, { input: { ascending: true } }], { pages: [page] });

    applyCachedOutputRating('a', 'r', client);

    expect(selectUnratedOutputs(readCachedGeneratorWorkflows(client)).has('a')).toBe(false);
    expect(selectUnratedOutputs(readCachedGeneratorWorkflows(client)).has('b')).toBe(true);
  });
});

describe('readCachedGeneratorWorkflows', () => {
  it('reads every page of every cached generator list', () => {
    const client = new QueryClient();
    const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);
    const page = (...ids: string[]) => ({ items: ids.map((id) => workflow(id, [])) });
    client.setQueryData([...queryKey, { input: { ascending: false } }], {
      pages: [page('a', 'b'), page('c')],
    });
    client.setQueryData([...queryKey, { input: { ascending: true } }], {
      pages: [page('d')],
    });
    client.setQueryData(['somethingElse'], { pages: [page('x')] });

    expect(
      readCachedGeneratorWorkflows(client)
        .map((x) => x.id)
        .sort()
    ).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('generator list opts into the hold', () => {
  it('builds WorkflowData with holdUnrated', () => {
    const source = readFileSync(
      resolve(__dirname, '..', 'generationRequestHooks.ts'),
      'utf8'
    ).replace(/\s+/g, ' ');
    const calls = source.match(/new WorkflowData\([^)]*\)/g) ?? [];

    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/\{ domain, nsfwEnabled, holdUnrated: true \}/);
  });
});
