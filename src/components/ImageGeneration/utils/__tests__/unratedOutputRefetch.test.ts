import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UNRATED_REFETCH_INTERVAL_MS,
  UNRATED_REFETCH_MAX_ATTEMPTS,
  createUnratedRefetchScheduler,
  readCachedGeneratorWorkflows,
  selectUnratedRefetch,
} from '~/components/ImageGeneration/utils/unratedOutputRefetch';
import { trpc } from '~/utils/trpc';

const workflow = (id: string, output: Array<Record<string, unknown>>) => ({
  id,
  steps: [{ output }],
});
const image = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'image',
  available: true,
  ...over,
});

describe('selectUnratedRefetch', () => {
  it('re-fetches a workflow holding an available output with no rating', () => {
    const { workflowIds, blobIds } = selectUnratedRefetch(
      [workflow('wf-1', [image('a')]), workflow('wf-2', [image('b', { nsfwLevel: 'r' })])],
      new Map()
    );

    expect(workflowIds).toEqual(['wf-1']);
    expect(blobIds).toEqual(['a']);
  });

  it('ignores outputs that are rated, blocked, not yet available, or never rated', () => {
    const { workflowIds } = selectUnratedRefetch(
      [
        workflow('rated', [image('a', { nsfwLevel: 'pg' })]),
        workflow('blocked', [image('b', { blockedReason: 'NSFWLevel' })]),
        workflow('pending', [image('c', { available: false })]),
        workflow('audio', [image('d', { type: 'audio' })]),
        workflow('mesh', [image('e', { type: 'model3d' })]),
        workflow('unscanned', [image('f', { type: 'video', nsfwLevel: 'na' })]),
      ],
      new Map()
    );

    expect(workflowIds).toEqual([]);
  });

  it('includes an unrated video', () => {
    const { workflowIds } = selectUnratedRefetch(
      [workflow('wf-1', [image('a', { type: 'video' })])],
      new Map()
    );

    expect(workflowIds).toEqual(['wf-1']);
  });

  it('skips unrated video from an engine the orchestrator never rates, as WorkflowData does', () => {
    const kling = { params: { ecosystem: 'Kling' } };
    const video = (id: string) => [image(id, { type: 'video' })];
    const { workflowIds } = selectUnratedRefetch(
      [
        { id: 'wf-level', metadata: kling, steps: [{ $type: 'videoGen', output: video('a') }] },
        { id: 'step-level', steps: [{ $type: 'videoGen', metadata: kling, output: video('b') }] },
        { id: 'image', steps: [{ $type: 'videoGen', metadata: kling, output: [image('c')] }] },
        { id: 'upscale', steps: [{ $type: 'videoUpscaler', metadata: kling, output: video('d') }] },
        {
          id: 'own-params',
          metadata: kling,
          steps: [{ $type: 'videoGen', metadata: { params: { prompt: 'x' } }, output: video('e') }],
        },
      ],
      new Map()
    );

    expect(workflowIds).toEqual(['image', 'upscale', 'own-params']);
  });

  it('stops once an output has used up its attempts', () => {
    const spent = new Map([['a', UNRATED_REFETCH_MAX_ATTEMPTS]]);
    const almost = new Map([['a', UNRATED_REFETCH_MAX_ATTEMPTS - 1]]);

    expect(selectUnratedRefetch([workflow('wf-1', [image('a')])], spent).workflowIds).toEqual([]);
    expect(selectUnratedRefetch([workflow('wf-1', [image('a')])], almost).workflowIds).toEqual([
      'wf-1',
    ]);
  });

  it('keeps re-fetching for a fresh output after another one gave up', () => {
    const spent = new Map([['a', UNRATED_REFETCH_MAX_ATTEMPTS]]);
    const { workflowIds, blobIds } = selectUnratedRefetch(
      [workflow('wf-1', [image('a'), image('b')])],
      spent
    );

    expect(workflowIds).toEqual(['wf-1']);
    expect(blobIds).toEqual(['b']);
  });

  it('lists a workflow once however many outputs it is waiting on', () => {
    const { workflowIds } = selectUnratedRefetch(
      [workflow('wf-1', [image('a'), image('b')]), workflow('wf-1', [image('a'), image('b')])],
      new Map()
    );

    expect(workflowIds).toEqual(['wf-1']);
  });
});

describe('createUnratedRefetchScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const neverRated = () => {
    const refetch = vi.fn<(ids: string[]) => Promise<void>>(async () => undefined);
    const schedule = createUnratedRefetchScheduler({
      readWorkflows: () => [workflow('wf-1', [image('a')])],
      refetch,
    });
    return { refetch, schedule };
  };

  it('re-reads every interval and stops at the attempt cap', async () => {
    const { refetch, schedule } = neverRated();
    schedule();
    // 2x the budget: a missing cap shows as a count past it.
    await vi.advanceTimersByTimeAsync(
      UNRATED_REFETCH_INTERVAL_MS * UNRATED_REFETCH_MAX_ATTEMPTS * 2
    );

    expect(refetch).toHaveBeenCalledTimes(UNRATED_REFETCH_MAX_ATTEMPTS);
    expect(refetch).toHaveBeenLastCalledWith(['wf-1']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits one interval before the first re-read', async () => {
    const { refetch, schedule } = neverRated();
    schedule();
    await vi.advanceTimersByTimeAsync(UNRATED_REFETCH_INTERVAL_MS - 1);
    expect(refetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('runs one timer however often it is asked', async () => {
    const { refetch, schedule } = neverRated();
    schedule();
    schedule();
    schedule();
    await vi.advanceTimersByTimeAsync(UNRATED_REFETCH_INTERVAL_MS);

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps going after a failed re-read', async () => {
    const refetch = vi.fn<(ids: string[]) => Promise<void>>(async () => {
      throw new Error('orchestrator down');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const schedule = createUnratedRefetchScheduler({
      readWorkflows: () => [workflow('wf-1', [image('a')])],
      refetch,
    });
    schedule();
    await vi.advanceTimersByTimeAsync(UNRATED_REFETCH_INTERVAL_MS * 2);

    expect(refetch).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('stops once the rating lands', async () => {
    let rated = false;
    const refetch = vi.fn<(ids: string[]) => Promise<void>>(async () => {
      rated = true;
    });
    const schedule = createUnratedRefetchScheduler({
      readWorkflows: () => [workflow('wf-1', [image('a', rated ? { nsfwLevel: 'x' } : {})])],
      refetch,
    });
    schedule();
    await vi.advanceTimersByTimeAsync(UNRATED_REFETCH_INTERVAL_MS * 4);

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps one re-read per interval when asked again while one is in flight', async () => {
    let release: () => void = () => undefined;
    const refetch = vi.fn<(ids: string[]) => Promise<void>>(
      () => new Promise<void>((resolve) => (release = resolve))
    );
    const schedule = createUnratedRefetchScheduler({
      readWorkflows: () => [workflow('wf-1', [image('a')])],
      refetch,
    });
    schedule();
    await vi.advanceTimersByTimeAsync(UNRATED_REFETCH_INTERVAL_MS);
    expect(refetch).toHaveBeenCalledTimes(1);

    schedule();
    release();
    await vi.advanceTimersByTimeAsync(UNRATED_REFETCH_INTERVAL_MS - 1);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it('does nothing when nothing is waiting on a rating', async () => {
    const refetch = vi.fn<(ids: string[]) => Promise<void>>(async () => undefined);
    const schedule = createUnratedRefetchScheduler({
      readWorkflows: () => [workflow('wf-1', [image('a', { nsfwLevel: 'pg' })])],
      refetch,
    });
    schedule();
    await vi.advanceTimersByTimeAsync(UNRATED_REFETCH_INTERVAL_MS * 4);

    expect(refetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
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
