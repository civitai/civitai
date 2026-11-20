import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAxiomLogger } from '@civitai/axiom/client';
import { createFliptClient, fliptEvalErrorRecord } from '@civitai/flipt';
import snapshot from '~/server/services/__tests__/fixtures/flipt-store-scope.snapshot.json';
import {
  startFliptFixtureServer,
  type FliptFixtureServer,
} from '~/server/services/__tests__/fixtures/flipt-fixture-server';

/**
 * A Flipt evaluation error, as `~/server/flipt/client` logs it: the real client and wasm engine
 * against a snapshot without the key, through a production-mode app logger. That module's
 * `~/env/server` cannot load in a unit run, so its one-line `onEvalError` is repeated here.
 */

let server: FliptFixtureServer;
let errorSpy: ReturnType<typeof vi.spyOn>;
const sink: { body: string; data: Record<string, unknown> }[] = [];

function build() {
  const { logToAxiom } = createAxiomLogger(
    { isProd: true, token: undefined, orgId: undefined, datastream: 'fixture-default' },
    { emitLog: (body, data) => sink.push({ body, data }) }
  );
  return createFliptClient({
    url: server.url,
    clientToken: 'test-token',
    environment: 'civitai-app',
    log: () => undefined,
    onInitError: (e) => {
      throw e;
    },
    onEvalError: (error, flag) => logToAxiom(fliptEvalErrorRecord(error, flag)),
  });
}

beforeAll(async () => {
  server = await startFliptFixtureServer(snapshot);
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  sink.length = 0;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('a Flipt evaluation error', () => {
  it('is one single-line structured record carrying the flag key, the message and the stack', async () => {
    const flipt = build();
    await flipt.ensureInitialized();
    // Instrument control: the engine is live, and a key it has evaluates without logging.
    expect(await flipt.readBoolean('app-blocks-enabled')).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();

    expect(await flipt.isEnabled('fixture-no-such-flag')).toBe(false);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const args = errorSpy.mock.calls[0] as unknown[];
    expect(args).toHaveLength(1);
    const line = args[0] as string;
    expect(line).not.toContain('\n');
    const record = JSON.parse(line);
    expect(record).toMatchObject({
      _axiom: 'fixture-default',
      name: 'flipt-eval-error',
      type: 'error',
      flag: 'fixture-no-such-flag',
    });
    expect(record.message).toMatch(/fixture-no-such-flag/);
    expect(record.stack).toContain('\n');

    expect(sink.map((s) => s.body)).toEqual([line]);
  });
});
