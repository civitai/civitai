import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { createOtelLoggerProvider } from '@civitai/telemetry/otel-logs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DbClient from '~/server/db/client';

/**
 * The app's real Prisma shim (the unit setup mocks it; this loads the actual module) composed with
 * the real OTel bridge, as `instrumentation.node.ts` registers it. A Prisma error event on a shim
 * client must come out as one ERROR record on the console datastream.
 */

type LogEmitter = { emit: (event: string, payload: unknown) => boolean };
const raise = (client: object, level: string, payload: unknown) =>
  (client as { _engineConfig: { logEmitter: LogEmitter } })._engineConfig.logEmitter.emit(
    level,
    payload
  );

const CLOSED = 'Error in PostgreSQL connection: Error { kind: Closed, cause: None }';
const ENV_KEYS = ['LOGGING', 'OTEL_LOGS_ENABLED'] as const;

type ExportedRecord = {
  severityNumber?: number;
  severityText?: string;
  body?: unknown;
  attributes: Record<string, unknown>;
};
const exported: ExportedRecord[] = [];
const provider = createOtelLoggerProvider({
  exporter: {
    export: (records, done) => {
      exported.push(...(records as unknown as ExportedRecord[]));
      done({ code: 0 });
    },
    shutdown: async () => undefined,
    forceFlush: async () => undefined,
  },
});
const flushed = async () => {
  await provider.forceFlush();
  return exported.splice(0);
};
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const savedClients = globalThis.__civitaiPrismaClients;
let savedEmit: ((...args: never[]) => unknown) | undefined;
let shim: typeof DbClient;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  process.env.LOGGING = 'prisma:error,prisma:warn,prisma:info';
  process.env.OTEL_LOGS_ENABLED = 'true';
  globalThis.__civitaiPrismaClients = undefined;
  logs.setGlobalLoggerProvider(provider);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  // Fresh module instances, so @civitai/db reads LOGGING now rather than from an earlier file.
  vi.resetModules();
  const sink = await import('~/server/logging/structured-log-sink');
  const { emitOtelLog } = await import('@civitai/telemetry/otel-logs');
  savedEmit = sink.structuredLogSink.emitLog;
  sink.setStructuredLogSink(emitOtelLog);
  shim = await vi.importActual<typeof DbClient>('~/server/db/client');
});

afterAll(async () => {
  await shim?.dbWrite.$disconnect();
  await shim?.dbRead.$disconnect();
  const sink = await import('~/server/logging/structured-log-sink');
  sink.structuredLogSink.emitLog = savedEmit as typeof sink.structuredLogSink.emitLog;
  globalThis.__civitaiPrismaClients = savedClients;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  logSpy.mockRestore();
  logs.disable();
  await provider.shutdown();
});

describe('the app Prisma shim', () => {
  it('turns a Prisma error event into one ERROR record on the console datastream', async () => {
    await flushed();

    raise(shim.dbWrite, 'error', { timestamp: new Date(0), message: CLOSED, target: 'quaint' });

    const records = await flushed();
    expect(records).toHaveLength(1);
    expect(records[0].severityNumber).toBe(SeverityNumber.ERROR);
    expect(records[0].severityText).toBe('ERROR');
    expect(records[0].body).toBe(`prisma:error ${CLOSED}`);
    expect(records[0].attributes).toEqual({
      'civitai.datastream': 'civitai-console',
      'civitai.type': 'error',
      'civitai.name': 'prisma',
      'civitai.source': 'prisma',
    });
  });

  it('records a warn event as WARN, and prints but never records an info event', async () => {
    await flushed();

    raise(shim.dbWrite, 'warn', { timestamp: new Date(0), message: 'w', target: 't' });
    raise(shim.dbWrite, 'info', { timestamp: new Date(0), message: 'i', target: 't' });

    const records = await flushed();
    expect(records.map((r) => [r.severityNumber, r.body])).toEqual([
      [SeverityNumber.WARN, 'prisma:warn w'],
    ]);
    expect(logSpy).toHaveBeenCalledWith('prisma:info', 'i');
  });

  it('under the console backstop, still one record per error event and none for info', async () => {
    const { installConsoleOtlpBackstop } = await import('~/server/logging/console-otlp-backstop');
    const sink = await import('~/server/logging/structured-log-sink');
    const backstop = installConsoleOtlpBackstop({ emit: sink.emitConsoleLog })!;
    try {
      await flushed();

      raise(shim.dbWrite, 'error', { timestamp: new Date(0), message: CLOSED, target: 'quaint' });
      raise(shim.dbWrite, 'info', { timestamp: new Date(0), message: 'i', target: 't' });
      // Positive control: the backstop is live in this harness.
      console.log('raw line');

      const records = await flushed();
      expect(records.map((r) => [r.attributes['civitai.source'], r.body])).toEqual([
        ['prisma', `prisma:error ${CLOSED}`],
        ['console', 'raw line'],
      ]);
    } finally {
      backstop.uninstall();
    }
  });
});
