export type RunProgress = {
  runId: number;
  status: 'running' | 'done' | 'failed' | 'interrupted';
  done: number;
  total: number | null;
};

export const POLL_MS = 3000;
const MAX_FAILED_READS = 5;

export const LOST_TRACK = 'Lost track of the run — it keeps going; see Test sets for its results.';

export async function fetchRunProgress(setId: number, runId: number): Promise<RunProgress> {
  const res = await fetch(`/text-scan/test-sets/${setId}/runs/${runId}`);
  if (!res.ok) throw new Error(`Could not read run ${runId}.`);
  return (await res.json()) as RunProgress;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * Reads the runs until none is still running, reporting each round. Resolves with their last state,
 * or null when aborted. A read that fails is tried again next round; several in a row throw
 * `LOST_TRACK`.
 */
export async function pollRuns(opts: {
  runIds: number[];
  read: (runId: number) => Promise<RunProgress>;
  onProgress: (progress: RunProgress[]) => void;
  intervalMs?: number;
  signal?: AbortSignal;
}): Promise<RunProgress[] | null> {
  const { runIds, read, onProgress, intervalMs = POLL_MS, signal } = opts;
  let failed = 0;
  for (;;) {
    if (signal?.aborted) return null;
    let progress: RunProgress[] | null = null;
    try {
      progress = await Promise.all(runIds.map(read));
      failed = 0;
    } catch {
      if (++failed >= MAX_FAILED_READS) throw new Error(LOST_TRACK);
    }
    if (signal?.aborted) return null;
    if (progress) {
      onProgress(progress);
      if (progress.every((p) => p.status !== 'running')) return progress;
    }
    await wait(intervalMs, signal);
  }
}

export function progressText(progress: RunProgress[], titles: string[]): string {
  return progress
    .map((p, i) => {
      const count = p.total === null ? `${p.done} scanned` : `${p.done} of ${p.total}`;
      return titles[i] ? `${titles[i]} ${count}` : count;
    })
    .join(' · ');
}
