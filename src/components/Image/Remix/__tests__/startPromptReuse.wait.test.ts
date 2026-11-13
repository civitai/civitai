import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GenerationGraphStore from '~/store/generation-graph.store';
import type * as Trpc from '~/utils/trpc';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';

// The unit project runs in `node`, so `persist` needs a sessionStorage before the store loads.
const session = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
    clear: () => session.clear(),
  },
});

const mint = vi.fn();

vi.mock('~/store/generation-graph.store', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationGraphStore>()),
  generationGraphPanel: { open: vi.fn() },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpcVanilla: {
    orchestrator: { mintPromptProvenance: { mutate: (...a: unknown[]) => mint(...a) } },
  },
}));

const { startPromptReuse } = await import('../remix.utils');
const { remixProvenanceStore, waitForPromptMint, PROMPT_MINT_WAIT_MS } = await import(
  '~/store/remix-provenance.store'
);

function image(id: number) {
  return {
    id,
    url: `img-${id}`,
    type: MediaType.image,
    ingestion: ImageIngestionStatus.Scanned,
    nsfwLevel: 1,
    width: 832,
    height: 1216,
  } as Parameters<typeof startPromptReuse>[0];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * A reuse-prompt token lands only when its mint answers, which in production can be 30s or more
 * after the click. A submit reads the token once; these pin that it waits for an in-flight mint
 * for the image its claim names, for a bounded time, and for nothing else.
 */

beforeEach(() => {
  remixProvenanceStore.clearAll();
  mint.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForPromptMint', () => {
  it('a submit made before the mint answers gets the token once it does', async () => {
    const answer = deferred<{ provenance: string }>();
    mint.mockReturnValueOnce(answer.promise);
    startPromptReuse(image(111));

    // What a submit read at click time: nothing yet.
    expect(remixProvenanceStore.getPromptToken(111)).toBeUndefined();

    let settled: { timedOut: boolean } | undefined;
    const waiting = waitForPromptMint(111).then((result) => {
      settled = result;
      // Read at the moment the wait ends, as the submit does.
      return remixProvenanceStore.getPromptToken(111);
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(settled).toBeUndefined();
    answer.resolve({ provenance: 'late-token' });

    await expect(waiting).resolves.toBe('late-token');
    expect(settled).toEqual({ timedOut: false });
  });

  it('gives up after the bound and submits without the token', async () => {
    mint.mockReturnValueOnce(new Promise(() => undefined));
    startPromptReuse(image(111));

    let settled: { timedOut: boolean } | undefined;
    void waitForPromptMint(111).then((result) => (settled = result));

    await vi.advanceTimersByTimeAsync(PROMPT_MINT_WAIT_MS - 100);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toEqual({ timedOut: true });
    expect(remixProvenanceStore.getPromptToken(111)).toBeUndefined();
  });

  it('waits 10 seconds', () => {
    expect(PROMPT_MINT_WAIT_MS).toBe(10_000);
  });

  it('does not wait on a mint for a different image', async () => {
    mint.mockReturnValueOnce(new Promise(() => undefined));
    startPromptReuse(image(111));

    let settled: { timedOut: boolean } | undefined;
    void waitForPromptMint(222).then((result) => (settled = result));
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toEqual({ timedOut: false });
  });

  it('does not wait once the mint has answered', async () => {
    mint.mockResolvedValueOnce({ provenance: 'token' });
    startPromptReuse(image(111));
    await vi.advanceTimersByTimeAsync(0);

    let settled: { timedOut: boolean } | undefined;
    void waitForPromptMint(111).then((result) => (settled = result));
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toEqual({ timedOut: false });
    expect(remixProvenanceStore.getPromptToken(111)).toBe('token');
  });
});
