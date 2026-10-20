/**
 * A runner process for the crash-recovery test: the real Runner and HTTP app on DBOS, with a
 * scripted model, file-backed heads and tools that log each call to a file, so what one process did
 * is visible to the next. Prints `READY <port>` once it listens.
 *
 * Env: DATABASE_URL, RUNNER_EXECUTOR_ID, FIXTURE_DIR.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildApp } from '../app';
import { Runner } from '../runner';
import { bearerAuthenticator, fakeTools, untilAborted } from './fakes';
import { FileConversationStore } from './file-store';
import { scriptedModel, toolResults } from './scripted-model';

const dir = process.env.FIXTURE_DIR!;
const callLog = join(dir, 'calls.log');
const logCall = (name: string) => appendFileSync(callLog, `${name} ${process.pid}\n`);

const tools = fakeTools({
  record: async () => {
    logCall('record');
    return 'recorded';
  },
  slow: async (_input, { abortSignal }) => {
    logCall('slow');
    return untilAborted(abortSignal);
  },
});

const runner = new Runner({
  models: {
    languageModel: () =>
      scriptedModel((prompt) => {
        const results = toolResults(prompt);
        if (results === 0)
          return { text: 'Step one. ', calls: [{ toolName: 'record', input: {} }] };
        if (results === 1) return { text: 'Step two. ', calls: [{ toolName: 'slow', input: {} }] };
        return { text: 'All done.' };
      }),
  },
  tools: tools.provider,
  store: new FileConversationStore(join(dir, 'heads')),
  log: {
    info: () => undefined,
    warn: (object, message) => console.warn(message, object),
    error: (object, message) => console.error(message, object),
  },
  wallClockMs: 120_000,
  stopGraceMs: 5000,
});

runner.register();
await runner.launch({
  databaseUrl: process.env.DATABASE_URL!,
  executorId: process.env.RUNNER_EXECUTOR_ID!,
  workerConcurrency: 4,
  logLevel: 'warn',
});
const app = buildApp({ service: runner, authenticator: bearerAuthenticator });
await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
console.log(`READY ${typeof address === 'object' && address ? address.port : 0}`);

process.on('SIGTERM', () => {
  void app
    .close()
    .then(() => runner.shutdown())
    .finally(() => process.exit(0));
});
