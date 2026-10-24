import { describe, expect, it, vi } from 'vitest';
import { attachImports } from '~/components/Moderation/HuggingFaceImport/attach-imports';

const chosen = [
  { id: 1, type: 'Model' as const },
  { id: 2, type: 'VAE' as const },
  { id: 3, type: 'Config' as const },
];

describe('attachImports', () => {
  it('attaches every chosen import and reports the files it created', async () => {
    const attachOne = vi.fn(async ({ id }: { id: number }) => ({ modelFileId: id + 100 }));

    const result = await attachImports({ chosen, modelVersionId: 42, attachOne });

    expect(attachOne).toHaveBeenCalledTimes(3);
    expect(attachOne.mock.calls.map(([input]) => input)).toEqual([
      { id: 1, modelVersionId: 42, type: 'Model' },
      { id: 2, modelVersionId: 42, type: 'VAE' },
      { id: 3, modelVersionId: 42, type: 'Config' },
    ]);
    expect(result).toEqual({ modelFileIds: [101, 102, 103], failures: [] });
  });

  it('keeps going after a failure, and reports the files that WERE created', async () => {
    // The router creates the ModelFile before it claims the import, so a lost claim leaves a real
    // file behind. Counting successes instead of naming ids loses the only handle to it.
    const attachOne = vi.fn(async ({ id }: { id: number }) => {
      if (id === 2) throw new Error('Created model file 555, but someone else attached it first.');
      return { modelFileId: id + 100 };
    });

    const result = await attachImports({ chosen, modelVersionId: 42, attachOne });

    // Three calls, not two: an early break or a `.every` would stop at the failure and silently
    // skip the rest of what the moderator asked for.
    expect(attachOne).toHaveBeenCalledTimes(3);
    expect(result.modelFileIds).toEqual([101, 103]);
    expect(result.failures).toEqual([
      'Created model file 555, but someone else attached it first.',
    ]);
  });

  it('collects EVERY failure message, not just the first', async () => {
    const attachOne = vi.fn(async ({ id }: { id: number }) => {
      throw new Error(`failed ${id}`);
    });

    const result = await attachImports({ chosen, modelVersionId: 42, attachOne });

    expect(result.modelFileIds).toEqual([]);
    expect(result.failures).toEqual(['failed 1', 'failed 2', 'failed 3']);
  });

  it('starts each call only after the previous one settled', async () => {
    // Held open until released, so "waited for the previous call" cannot be confused with "waited a
    // moment" — a staggered parallel loop still starts all three while the first is unresolved.
    const releases: Array<() => void> = [];
    const attachOne = vi.fn(
      ({ id }: { id: number }) =>
        new Promise<{ modelFileId: number }>((resolve) =>
          releases.push(() => resolve({ modelFileId: id }))
        )
    );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

    const done = attachImports({ chosen, modelVersionId: 42, attachOne });
    for (let started = 1; started <= chosen.length; started++) {
      await settle();
      expect(attachOne).toHaveBeenCalledTimes(started);
      releases[started - 1]();
    }
    await expect(done).resolves.toEqual({ modelFileIds: [1, 2, 3], failures: [] });
  });

  it('reports a rejection that is not an Error by its value', async () => {
    const attachOne = vi.fn(async () => {
      throw 'storage resolver unavailable';
    });

    const result = await attachImports({
      chosen: chosen.slice(0, 1),
      modelVersionId: 42,
      attachOne,
    });

    expect(result.failures).toEqual(['storage resolver unavailable']);
  });

  it('does nothing when nothing was chosen', async () => {
    const attachOne = vi.fn();
    const result = await attachImports({ chosen: [], modelVersionId: 42, attachOne });

    expect(attachOne).not.toHaveBeenCalled();
    expect(result).toEqual({ modelFileIds: [], failures: [] });
  });
});
