/**
 * When App Assistant's changes to an app are committed to the app's source repo (the developer's
 * git history on the platform git host). The page and the server runner each make one scheduler
 * per chat or run and tell it every change the gate reports (`GateCoreOptions.onAppChanged`);
 * `save` asks civitai to commit the app as the sandbox holds it now.
 *
 * One save per quiet spell, not one per call: a reply that edits ten files makes one commit once
 * it has paused for {@link SOURCE_SAVE_QUIET_MS}, or when the reply ends (`flush`). Saves never
 * overlap: a change during a save schedules the next one. A save that fails is not retried here
 * (the next change saves everything since, since a save commits the whole app).
 */

/** How long after the last change a save waits. */
export const SOURCE_SAVE_QUIET_MS = 20_000;

export interface SourceSaveScheduler {
  /** A change to `app`'s files. A pending save of ANOTHER app is made first. */
  changed(app: string): void;
  /** Make the pending save now (the reply ended); resolves once no save is pending or running. */
  flush(): Promise<void>;
  /** Drop a pending save and stop (the chat is gone). */
  dispose(): void;
}

export interface SourceSaveSchedulerOptions {
  save: (app: string) => Promise<unknown>;
  quietMs?: number;
  /** Told of a save that threw; the scheduler carries on. */
  onError?: (error: unknown, app: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createSourceSaveScheduler({
  save,
  quietMs = SOURCE_SAVE_QUIET_MS,
  onError,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: SourceSaveSchedulerOptions): SourceSaveScheduler {
  // Insertion-ordered: the app changed first is saved first.
  const pending = new Set<string>();
  let timer: unknown = null;
  let running: Promise<void> | null = null;
  let disposed = false;

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  /** Save every pending app, one at a time; joins the drain already running. */
  const drain = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      while (!disposed && pending.size) {
        const app = pending.values().next().value as string;
        pending.delete(app);
        try {
          await save(app);
        } catch (error) {
          onError?.(error, app);
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    changed(app) {
      if (disposed) return;
      const another = [...pending].some((a) => a !== app);
      pending.add(app);
      cancelTimer();
      // Another app opened while one waited: save both now rather than mix their quiet spells.
      if (another) {
        void drain();
        return;
      }
      timer = setTimer(() => {
        timer = null;
        void drain();
      }, quietMs);
    },
    async flush() {
      cancelTimer();
      await drain();
    },
    dispose() {
      disposed = true;
      pending.clear();
      cancelTimer();
    },
  };
}
