import type { ResumePoint } from '@civitai/components-chat/core';
import type {
  ConversationPatchRequest,
  RunEndStatus,
  RunSettings,
  RunSummary,
  StartRunRequest,
  TurnUser,
} from '@civitai/components-chat/runner-protocol';

import type { ConversationStore, Logger, ModelProvider, ToolProvider } from './interfaces';
import type { JournalEntry, RunService, StartOutcome } from './service';

// Stub: the DBOS runner lands in the next commit.
export interface ReplyInput {
  runId: string;
  userId: string;
  conversationId: string;
  scope?: string;
  seq: number;
  user: TurnUser;
  retry: boolean;
  model: string;
  settings: RunSettings;
  page?: StartRunRequest['page'];
  wallClockMs: number;
}

export interface ReplyOutput {
  status: RunEndStatus;
  steps: number;
  resume?: ResumePoint;
}

export interface RunnerDeps {
  models: ModelProvider;
  tools: ToolProvider;
  store: ConversationStore;
  log: Logger;
  wallClockMs: number;
  stopGraceMs: number;
}

export interface LaunchOptions {
  databaseUrl: string;
  executorId: string;
  workerConcurrency: number;
  logLevel?: string;
}

const stub = (): never => {
  throw new Error('not implemented');
};

export class Runner implements RunService {
  constructor(_deps: RunnerDeps) {}
  register(): void {}
  async launch(_options: LaunchOptions): Promise<void> {
    stub();
  }
  async shutdown(): Promise<void> {}
  ready(): boolean {
    return false;
  }
  async start(_userId: string, _request: StartRunRequest): Promise<StartOutcome> {
    return stub();
  }
  async lookup(_userId: string, _conversationId: string): Promise<RunSummary | null> {
    return stub();
  }
  async owns(_userId: string, _runId: string): Promise<boolean> {
    return stub();
  }
  async *events(
    _runId: string,
    _after: number | undefined,
    _signal: AbortSignal
  ): AsyncIterable<JournalEntry> {
    yield stub();
  }
  async stop(_userId: string, _runId: string): Promise<boolean> {
    return stub();
  }
  async stopByKey(_userId: string, _idempotencyKey: string): Promise<void> {
    stub();
  }
  async patch(
    _userId: string,
    _conversationId: string,
    _patch: ConversationPatchRequest
  ): Promise<boolean> {
    return stub();
  }
}
