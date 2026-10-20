import type { TurnPart } from '@civitai/components-chat/core';
import type { RunEvent } from '@civitai/components-chat/runner-protocol';

import type { Logger } from './interfaces';

export interface RunEmitterOptions {
  write(event: RunEvent): Promise<void>;
  parts(): readonly TurnPart[] | undefined;
  shown: readonly TurnPart[];
  log: Logger;
  flushMs?: number;
}

// Stub: the journal emitter lands in the next commit.
export class RunEmitter {
  constructor(_options: RunEmitterOptions) {}
  partsChanged(): void {}
  flushParts(): void {}
  emit(_event: RunEvent): void {}
  async drain(): Promise<void> {}
  close(): void {}
}
