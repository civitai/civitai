import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GenerationGraphStore from '~/store/generation-graph.store';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';

/**
 * There is ONE prompt token, and the mints that fill it resolve in whatever
 * order the network gives them — so the ordering this pins is the only thing
 * standing between "the token names the image you last clicked" and "the token
 * names whichever mint happened to answer last". A store test cannot reach it:
 * every store call is synchronous, so last-write-wins holds there under an
 * implementation with no ordering guard at all.
 *
 * The unit project runs in `node`, so `persist` needs a sessionStorage before
 * the store module loads.
 */
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

vi.mock('~/utils/trpc', () => ({
  trpcVanilla: {
    orchestrator: { mintPromptProvenance: { mutate: (...a: unknown[]) => mint(...a) } },
  },
}));

const { startPromptReuse } = await import('../remix.utils');
const { remixProvenanceStore } = await import('~/store/remix-provenance.store');

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

beforeEach(() => {
  remixProvenanceStore.clearAll();
  mint.mockReset();
});

describe('startPromptReuse', () => {
  it('discards a mint that resolves after a newer click', async () => {
    const first = deferred<{ provenance: string }>();
    mint.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ provenance: 'second-token' });

    startPromptReuse(image(111));
    startPromptReuse(image(222));
    await Promise.resolve();

    first.resolve({ provenance: 'first-token' });
    await first.promise;
    await Promise.resolve();

    expect(remixProvenanceStore.getPromptToken(222)).toBe('second-token');
    expect(remixProvenanceStore.getPromptToken(111)).toBeUndefined();
  });

  /**
   * The ordinary case, so a guard that discarded everything would not read as a
   * pass above.
   */
  it('keeps a mint that is still the newest click', async () => {
    mint.mockResolvedValue({ provenance: 'only-token' });

    startPromptReuse(image(111));
    await Promise.resolve();
    await Promise.resolve();

    expect(remixProvenanceStore.getPromptToken(111)).toBe('only-token');
  });
});
