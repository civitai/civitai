import type { TurnPart } from '@civitai/components-chat/core';
import {
  createPartsDiffer,
  RUN_TEXT_FLUSH_MS,
  type PartsDiffer,
  type RunEvent,
} from '@civitai/components-chat/runner-protocol';

import type { Logger } from './interfaces';

export interface RunEmitterOptions {
  /** Appends one event to the run's journal. Called one at a time, in order. */
  write(event: RunEvent): Promise<void>;
  /** The parts the reply shows now (`AgentCore.live.parts`), `undefined` once it ended. */
  parts(): readonly TurnPart[] | undefined;
  /** The parts the journal already shows (what `run-started` and the edits after it built). */
  shown: readonly TurnPart[];
  log: Logger;
  flushMs?: number;
}

/**
 * Turns a reply's parts into journal events: at most one batch of edits per `flushMs`, each an edit
 * (a text delta, a call, a result) rather than the whole part, so a long text costs its length once.
 * Writes go one at a time, in order: concurrent stream writes race for the same journal offset.
 */
export class RunEmitter {
  readonly #options: RunEmitterOptions;
  readonly #differ: PartsDiffer;
  #chain: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #broken = false;

  constructor(options: RunEmitterOptions) {
    this.#options = options;
    this.#differ = createPartsDiffer(options.shown);
  }

  /** The parts changed: their edits go out within `flushMs`, together with anything else that changed meanwhile. */
  partsChanged(): void {
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      this.flushParts();
    }, this.#options.flushMs ?? RUN_TEXT_FLUSH_MS);
  }

  /** Sends the parts' edits now (before an event that must come after them). */
  flushParts(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const parts = this.#options.parts();
    if (parts) for (const event of this.#differ.diff(parts)) this.emit(event);
  }

  emit(event: RunEvent): void {
    this.#chain = this.#chain.then(async () => {
      if (this.#broken) return;
      try {
        await this.#options.write(event);
      } catch (error) {
        // Once a write is refused (the run was cancelled under us, the database went away) the
        // journal is no longer ours to append to; a later write would land out of order anyway.
        this.#broken = true;
        this.#options.log.error(
          { err: error, event: event.type },
          'journal write failed; no further events from this pass'
        );
      }
    });
  }

  /** Resolves once every event emitted so far is written (or given up on). */
  async drain(): Promise<void> {
    await this.#chain;
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
