import type { TrainingRunPayload } from '$lib/backend';
import type { BlobReadiness, ReadinessCheck, ReadinessProbe } from '$lib/upload-readiness';

/** What Review shows about its dataset files. `off`: Start as before, the submit decides. */
export type ReadinessView =
  | { kind: 'off' }
  | { kind: 'checking'; ready: number; total: number }
  | { kind: 'ready' }
  | { kind: 'unusable'; blobIds: string[] }
  | { kind: 'slow' };

export const READINESS_POLL_MS = 5000;
export const READINESS_MAX_MS = 3 * 60_000;
/** Each read of a failed file retries its processing, so it is read only this many times per visit. */
export const READINESS_FAILED_READS = 2;
/** Whatifs per visit: each refusal re-reads every file, since the refusal is what starts an older file. */
export const READINESS_CHECKS = 3;

export const holdsStart = (view: ReadinessView) =>
  view.kind === 'checking' || view.kind === 'unusable' || view.kind === 'slow';

/** `unusableCount` and `noun` let an edit dataset say how many pairs Remove takes out. */
export function readinessMessage(
  view: ReadinessView,
  { unusableCount, noun = 'file' }: { unusableCount?: number; noun?: 'file' | 'pair' } = {}
): string | null {
  switch (view.kind) {
    case 'checking':
      return `Finishing your uploads (${view.ready} of ${view.total} ready)…`;
    case 'unusable': {
      const n = unusableCount ?? view.blobIds.length;
      const what = n === 1 ? `1 ${noun} can't` : `${n} ${noun}s can't`;
      return `${what} be used for training. Remove ${n === 1 ? 'it' : 'them'} to continue.`;
    }
    case 'slow':
      return 'Some files are taking longer than usual. Check again in a few minutes.';
    default:
      return null;
  }
}

export interface ReadinessDeps {
  probe(blobIds: string[]): Promise<ReadinessProbe>;
  check(run: TrainingRunPayload): Promise<ReadinessCheck>;
  /** The run the submit would send now, or undefined when Review can't build one yet. */
  buildRun(): TrainingRunPayload | undefined;
  onView(view: ReadinessView): void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Reads every file once, then only the files not yet ready, until all are; then asks the orchestrator
 *  whether it would take the dataset. A dataset it refuses although every file read ready holds files it
 *  has only now started processing, so every file is read again. Any error ends the wait with `off`.
 *  Returns a stop function. */
export function watchReadiness(blobIds: string[], deps: ReadinessDeps): () => void {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const ids = [...new Set(blobIds)];
  let stopped = false;
  const show = (view: ReadinessView) => {
    if (!stopped) deps.onView(view);
  };

  const run = async () => {
    const states = new Map<string, BlobReadiness>();
    const failedReads = new Map<string, number>();
    const started = now();
    let checks = 0;
    show({ kind: 'checking', ready: 0, total: ids.length });
    for (;;) {
      const toRead = ids.filter(
        (id) =>
          states.get(id) !== 'ready' &&
          states.get(id) !== 'unusable' &&
          (failedReads.get(id) ?? 0) < READINESS_FAILED_READS
      );
      if (toRead.length > 0) {
        const res = await deps.probe(toRead);
        if (stopped) return;
        if (!res.enabled) return show({ kind: 'off' });
        for (const [id, state] of Object.entries(res.states)) {
          states.set(id, state);
          if (state === 'failed') failedReads.set(id, (failedReads.get(id) ?? 0) + 1);
        }
      }
      const unusable = ids.filter((id) => states.get(id) === 'unusable');
      if (unusable.length > 0) return show({ kind: 'unusable', blobIds: unusable });

      const ready = ids.filter((id) => states.get(id) === 'ready').length;
      if (ready === ids.length) {
        const runPayload = deps.buildRun();
        if (!runPayload) return show({ kind: 'ready' });
        const res = await deps.check(runPayload);
        if (stopped) return;
        if (!res.enabled || res.ready !== false) return show({ kind: 'ready' });
        if (++checks >= READINESS_CHECKS) return show({ kind: 'slow' });
        states.clear();
        if (now() - started >= READINESS_MAX_MS) return show({ kind: 'slow' });
        show({ kind: 'checking', ready: 0, total: ids.length });
        await sleep(READINESS_POLL_MS);
        if (stopped) return;
        continue;
      } else {
        const stuck = ids.every(
          (id) => states.get(id) === 'ready' || (failedReads.get(id) ?? 0) >= READINESS_FAILED_READS
        );
        if (stuck) return show({ kind: 'slow' });
      }
      if (now() - started >= READINESS_MAX_MS) return show({ kind: 'slow' });
      show({ kind: 'checking', ready, total: ids.length });
      await sleep(READINESS_POLL_MS);
      if (stopped) return;
    }
  };

  if (ids.length === 0) show({ kind: 'off' });
  else
    run().catch(() => {
      show({ kind: 'off' });
    });
  return () => {
    stopped = true;
  };
}
