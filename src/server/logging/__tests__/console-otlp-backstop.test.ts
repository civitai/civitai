import { inspect } from 'node:util';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { createAxiomLogger } from '@civitai/axiom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import {
  armConsoleOtlpBackstop,
  installConsoleOtlpBackstop,
  keepOtelDiagOffConsoleBackstop,
  type ConsoleBackstop,
  type ConsoleRecord,
} from '~/server/logging/console-otlp-backstop';
import { emitConsoleLog, structuredLogSink } from '~/server/logging/structured-log-sink';
import { createLogger } from '~/utils/logging';

type Emitted = { body: string; record: ConsoleRecord };

/** A console of plain spies, so a test sees exactly what the original methods received. */
function fakeConsole() {
  return {
    log: vi.fn(() => 'log-result'),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Console &
    Record<'log' | 'info' | 'warn' | 'error' | 'debug', ReturnType<typeof vi.fn>>;
}

function installOnFake(opts: Partial<Parameters<typeof installConsoleOtlpBackstop>[0]> = {}) {
  const target = fakeConsole();
  const originals = { ...target };
  const emitted: Emitted[] = [];
  const backstop = installConsoleOtlpBackstop({
    emit: (body, record) => emitted.push({ body, record }),
    target,
    ...opts,
  })!;
  return { target, originals, emitted, backstop };
}

describe('installConsoleOtlpBackstop', () => {
  it('calls the original first with the same this, arguments and return value', () => {
    const target = fakeConsole();
    const original = target.log;
    const order: string[] = [];
    original.mockImplementation(() => {
      order.push('original');
      return 'log-result';
    });
    installConsoleOtlpBackstop({ emit: () => order.push('emit'), target });

    const arg = { a: 1 };
    const result = target.log('x %d', 7, arg);

    expect(result).toBe('log-result');
    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.calls[0]).toEqual(['x %d', 7, arg]);
    expect(original.mock.calls[0][2]).toBe(arg);
    expect(original.mock.contexts[0]).toBe(target);
    expect(order).toEqual(['original', 'emit']);
  });

  it('sends one record per call, with the severity of the method', () => {
    const { target, emitted } = installOnFake();

    target.error('e');
    target.warn('w');
    target.log('l');
    target.info('i');
    target.debug('d');

    expect(emitted.map((e) => [e.body, e.record.type])).toEqual([
      ['e', 'error'],
      ['w', 'warn'],
      ['l', 'info'],
      ['i', 'info'],
      ['d', 'info'],
    ]);
    expect(emitted[0].record).toEqual({ source: 'console', name: 'console', type: 'error' });
  });

  it('formats the arguments as console does, without colour, cut to the body cap', () => {
    const { target, emitted } = installOnFake();

    target.log('\x1b[31mred\x1b[39m %s=%d', 'n', 42, { deep: { x: [1, 2] } });
    target.log('y'.repeat(2048 + 99));

    expect(emitted[0].body).toBe('red n=42 { deep: { x: [ 1, 2 ] } }');
    expect(emitted[1].body).toBe('y'.repeat(2048));
  });

  it('cuts a very large line before stripping colour, and strips before the final cut', () => {
    const { target, emitted } = installOnFake();
    const RED = '\x1b[31m';

    target.log('z'.repeat(20_000_000));
    // Colour codes before the text count toward the pre-strip cut but not toward the body.
    target.log(RED + 'r'.repeat(3000));
    // Past the pre-strip cut (4x the body cap) nothing is read, so a line of codes yields no text.
    // A 4-character code, so the cut at 8192 falls between codes.
    target.log('\x1b[1m'.repeat(3000) + 'tail');

    expect(emitted.map((e) => e.body)).toEqual(['z'.repeat(2048), 'r'.repeat(2048), '']);
  });

  it('redacts credentials in the forwarded body and leaves the stdout write untouched', () => {
    const { target, originals, emitted } = installOnFake();
    const line =
      'fetch failed https://example.test/f?token=abc123&page=2 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcd';

    target.error(line);

    expect(originals.error).toHaveBeenCalledWith(line);
    expect(emitted[0].body).toBe(
      'fetch failed https://example.test/f?token=[redacted]&page=2 Authorization: Bearer [redacted]'
    );
  });

  it('redacts credential-named fields of a logged object, leaving the argument itself alone', () => {
    const { target, originals, emitted } = installOnFake();
    const config = {
      url: '/api',
      token: 'tok-abc-123',
      headers: { authorization: 'Basic Zm9vOmJhcg==' },
    };

    target.log('config', config);

    expect(originals.log).toHaveBeenCalledWith('config', config);
    expect(config.token).toBe('tok-abc-123');
    expect(emitted[0].body).not.toContain('tok-abc-123');
    expect(emitted[0].body).not.toContain('Zm9vOmJhcg==');
    expect(emitted[0].body).toContain("url: '/api'");
  });

  it('redacts a backtick-quoted credential value and a credential Map entry', () => {
    const { target, emitted } = installOnFake();

    target.log(
      { password: `a'b"c-secret`, user: 'bob' },
      new Map([
        ['cookie', 'sid=map-secret'],
        ['page', '2'],
      ])
    );

    const body = emitted[0].body;
    expect(body).not.toContain('c-secret');
    expect(body).not.toContain('map-secret');
    expect(body).toContain('password: `[redacted]`');
    expect(body).toContain("'cookie' => '[redacted]'");
    expect(body).toContain("user: 'bob'");
    expect(body).toContain("'page' => '2'");
  });

  it('redacts credential fields inside an Error and a class instance, as inspect prints them', () => {
    const { target, emitted } = installOnFake();
    const err = Object.assign(new Error('request failed'), {
      config: { url: '/v1/x', headers: { authorization: 'Basic c2VjcmV0OnBhc3M=' } },
    });
    class Session {
      cookie = 'sid=s3cr3t-cookie-value';
      user = 'alice';
    }

    target.error(err, new Session());

    const body = emitted[0].body;
    expect(body).toContain('request failed');
    expect(body).toContain("url: '/v1/x'");
    expect(body).toContain("user: 'alice'");
    expect(body).not.toContain('c2VjcmV0OnBhc3M=');
    expect(body).not.toContain('s3cr3t-cookie-value');
    expect(body).toContain("authorization: '[redacted]'");
    expect(body).toContain("cookie: '[redacted]'");
  });

  it('turns console.error(err) into ONE record carrying the whole stack', () => {
    const { target, emitted } = installOnFake();
    const err = new Error('kaboom');

    target.error(err);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].body).toContain('Error: kaboom\n    at ');
    expect(emitted[0].body.split('\n').length).toBeGreaterThan(3);
  });

  it('does not forward a call made while forwarding is suppressed', async () => {
    const { withConsoleForwardingSuppressed } = await import('@civitai/axiom/console-forwarding');
    const { target, emitted } = installOnFake();

    withConsoleForwardingSuppressed(() => target.error('already forwarded'));
    target.error('raw');

    expect(emitted.map((e) => e.body)).toEqual(['raw']);
  });

  it('does not re-enter itself when the sink logs to the console', () => {
    const target = fakeConsole();
    const original = target.error;
    const emit = vi.fn(() => {
      target.error('sink complaint');
    });
    installConsoleOtlpBackstop({ emit, target });

    target.error('first');

    expect(emit).toHaveBeenCalledTimes(1);
    expect(original.mock.calls).toEqual([['first'], ['sink complaint']]);
  });

  it('never throws and never skips the write when emitting or formatting fails', () => {
    const target = fakeConsole();
    const original = target.log;
    let fail = true;
    const emit = vi.fn((_body: string, _record: ConsoleRecord) => {
      if (fail) throw new Error('sink down');
    });
    installConsoleOtlpBackstop({ emit, target });
    const unformattable = {
      [inspect.custom]() {
        throw new Error('cannot inspect');
      },
    };

    expect(() => target.log('emit throws')).not.toThrow();
    expect(() => target.log(unformattable)).not.toThrow();
    fail = false;
    target.log('recovered');

    expect(original.mock.calls).toEqual([['emit throws'], [unformattable], ['recovered']]);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][0]).toBe('recovered');
  });

  it('passes an original that throws through unchanged, without forwarding', () => {
    const target = fakeConsole();
    target.log.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    const emit = vi.fn();
    installConsoleOtlpBackstop({ emit, target });

    expect(() => target.log('x')).toThrow('EPIPE');
    expect(emit).not.toHaveBeenCalled();
  });

  it('caps records per second, counts the drops, and still writes every call', () => {
    let now = 5_000_250;
    const onDrop = vi.fn();
    const { target, originals, emitted } = installOnFake({ now: () => now, onDrop });

    for (let i = 0; i < 53; i++) target.log(`line ${i}`);
    expect(emitted).toHaveLength(50);
    expect(onDrop).toHaveBeenCalledTimes(3);
    expect(originals.log).toHaveBeenCalledTimes(53);

    now += 1_000;
    target.log('next second');
    expect(emitted).toHaveLength(51);
    expect(emitted[50].body).toBe('next second');
  });

  it('applies a cap passed in', () => {
    const onDrop = vi.fn();
    const { target, emitted } = installOnFake({ maxRecordsPerSecond: 3, now: () => 7, onDrop });

    for (let i = 0; i < 9; i++) target.warn(i);

    expect(emitted.map((e) => e.body)).toEqual(['0', '1', '2']);
    expect(onDrop).toHaveBeenCalledTimes(6);
  });

  it('caps bytes per second (64 KiB, counted in bytes), and resets the next second', () => {
    let now = 9_000_100;
    const onDrop = vi.fn();
    const { target, originals, emitted } = installOnFake({ now: () => now, onDrop });
    // 2048 two-byte characters: 4096 bytes per record, so 16 fit in 64 KiB (32 if chars counted).
    const wide = 'é'.repeat(2048);

    for (let i = 0; i < 20; i++) target.error(wide);
    expect(emitted).toHaveLength(16);
    expect(onDrop).toHaveBeenCalledTimes(4);
    expect(originals.error).toHaveBeenCalledTimes(20);

    now += 1_000;
    target.error(wide);
    expect(emitted).toHaveLength(17);
  });

  it('stops formatting once the record budget is spent, even when bytes were the limit', () => {
    const now = 9_500_100;
    const onDrop = vi.fn();
    const { target, emitted } = installOnFake({
      now: () => now,
      onDrop,
      maxRecordsPerSecond: 5,
      maxBytesPerSecond: 10,
    });
    const inspected = vi.fn(() => 'x'.repeat(50));
    const big = { [inspect.custom]: inspected };

    for (let i = 0; i < 20; i++) target.log(big);

    expect(emitted).toHaveLength(0);
    expect(onDrop).toHaveBeenCalledTimes(20);
    expect(inspected).toHaveBeenCalledTimes(5);
  });

  it('applies a byte budget passed in, by body size', () => {
    const onDrop = vi.fn();
    const { target, emitted } = installOnFake({ maxBytesPerSecond: 10, now: () => 3, onDrop });

    target.log('12345');
    target.log('123456');
    target.log('12345');

    expect(emitted.map((e) => e.body)).toEqual(['12345', '12345']);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('installs once: a second install changes nothing and still sends one record per call', () => {
    const { target, emitted } = installOnFake();
    const wrapped = target.log;
    const second: Emitted[] = [];

    const again = installConsoleOtlpBackstop({
      emit: (body, record) => second.push({ body, record }),
      target,
    });
    target.log('once');

    expect(again).toBeUndefined();
    expect(target.log).toBe(wrapped);
    expect(emitted).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('uninstall puts the original methods back', () => {
    const target = fakeConsole();
    const original = target.log;
    const emit = vi.fn();
    installConsoleOtlpBackstop({ emit, target })!.uninstall();

    target.log('after');

    expect(target.log).toBe(original);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('armConsoleOtlpBackstop', () => {
  it('leaves the console alone unless both gates are on', () => {
    const before = { log: console.log, error: console.error };

    expect(armConsoleOtlpBackstop({})).toBeUndefined();
    expect(armConsoleOtlpBackstop({ OTEL_LOGS_ENABLED: 'false' })).toBeUndefined();
    expect(armConsoleOtlpBackstop({ OTEL_LOGS_ENABLED: 'true' })).toBeUndefined();
    expect(
      armConsoleOtlpBackstop({ OTEL_LOGS_ENABLED: 'true', OTEL_CONSOLE_BACKSTOP_ENABLED: 'false' })
    ).toBeUndefined();
    expect(armConsoleOtlpBackstop({ OTEL_CONSOLE_BACKSTOP_ENABLED: 'true' })).toBeUndefined();

    expect(console.log).toBe(before.log);
    expect(console.error).toBe(before.error);
  });

  it('wraps the global console when OTLP logs and the backstop are both on', () => {
    const before = console.log;
    const backstop = armConsoleOtlpBackstop({
      OTEL_LOGS_ENABLED: 'true',
      OTEL_CONSOLE_BACKSTOP_ENABLED: 'true',
    });
    try {
      expect(backstop).toBeDefined();
      expect(console.log).not.toBe(before);
    } finally {
      backstop?.uninstall();
    }
    expect(console.log).toBe(before);
  });
});

/**
 * Each writer that already forwards its line (or keeps it on stdout on purpose), with the backstop
 * installed on the real console and wired as production wires it: the backstop's records and the
 * writer's own go to the same sink, so a doubled line shows up as a second record.
 */
describe('writers that already forward', () => {
  const sinkRecords: Array<{ body: string; data: Record<string, unknown>; datastream?: string }> =
    [];
  const stdout = {} as Record<
    'log' | 'info' | 'warn' | 'error' | 'debug',
    ReturnType<typeof vi.spyOn>
  >;
  let previousEmit: typeof structuredLogSink.emitLog;
  let backstop: ConsoleBackstop;

  const consoleRecords = () => sinkRecords.filter((r) => r.data.logSource === 'console');

  beforeEach(() => {
    sinkRecords.length = 0;
    previousEmit = structuredLogSink.emitLog;
    structuredLogSink.emitLog = (body, data, datastream) => {
      sinkRecords.push({ body, data, datastream });
    };
    // Silence the real console underneath, then wrap it as production does.
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
      stdout[m] = vi.spyOn(console, m).mockImplementation(() => undefined);
    backstop = installConsoleOtlpBackstop({ emit: emitConsoleLog })!;
  });

  afterEach(() => {
    backstop.uninstall();
    for (const spy of Object.values(stdout)) spy.mockRestore();
    structuredLogSink.emitLog = previousEmit;
  });

  it('positive control: a raw console call reaches the sink as one console record', () => {
    console.warn('raw library warning');

    expect(sinkRecords).toEqual([
      {
        body: 'raw library warning',
        data: { type: 'warn', name: 'console', logSource: 'console' },
        datastream: 'civitai-console',
      },
    ]);
  });

  it('createLogger: one record per call, its own', () => {
    setEnv({ LOGGING: ['backstop-writer-test'] });

    createLogger('backstop-writer-test')('did a thing', 3);

    expect(sinkRecords).toHaveLength(1);
    expect(sinkRecords[0].data.logSource).toBe('createLogger');
    expect(sinkRecords[0].body).toBe('backstop-writer-test did a thing 3');
  });

  it('createLogger with forward: false: stdout only, no record', () => {
    setEnv({ LOGGING: ['backstop-writer-test'] });

    createLogger('backstop-writer-test', 'blue', { forward: false })('SELECT 1');

    expect(stdout.log).toHaveBeenCalledTimes(1);
    expect(sinkRecords).toHaveLength(0);
  });

  it('logToAxiom in production: one record per event, its own', async () => {
    const { logToAxiom } = createAxiomLogger({ isProd: true, token: undefined }, structuredLogSink);

    await logToAxiom({ name: 'backstop-event', type: 'error', message: 'm' }, 'fixture-stream');

    expect(stdout.error).toHaveBeenCalledTimes(1);
    expect(sinkRecords).toHaveLength(1);
    expect(sinkRecords[0].data.name).toBe('backstop-event');
    expect(consoleRecords()).toHaveLength(0);
  });

  it('logToAxiom outside production: the local echo is not forwarded', async () => {
    const { logToAxiom } = createAxiomLogger({ isProd: false }, structuredLogSink);

    await logToAxiom({ name: 'backstop-event' });

    expect(stdout.log).toHaveBeenCalledTimes(1);
    expect(sinkRecords).toHaveLength(0);
  });

  it("the Axiom logger's self-report: one record, its own", async () => {
    // The report fires once per datastream per process; clear the shared set so it fires here.
    (globalThis as Record<symbol, unknown>)[
      Symbol.for('@civitai/axiom.unprovisionedDatastreamsReported')
    ] = new Set<string>();
    const { logToAxiom } = createAxiomLogger(
      { isProd: true, token: 't', orgId: 'o', provisionedDatastreams: new Set() },
      structuredLogSink
    );

    await logToAxiom({ name: 'backstop-event' }, 'fixture-unprovisioned-stream');

    expect(stdout.error).toHaveBeenCalledTimes(2);
    expect(sinkRecords.map((r) => r.data.name)).toEqual([
      'backstop-event',
      'axiom-datastream-unprovisioned',
    ]);
    expect(consoleRecords()).toHaveLength(0);
  });
});

/**
 * A failed export reports through OTel's diag logger from an async continuation, after the
 * wrapper's synchronous guard is down. Forwarded, that report is queued into the next export, which
 * fails and reports again, one record per export for as long as the collector is down.
 */
describe('keepOtelDiagOffConsoleBackstop', () => {
  afterEach(() => {
    diag.disable();
    vi.unstubAllEnvs();
  });

  async function exportFailuresAcrossThreeFlushes({ reroute }: { reroute: boolean }) {
    const { createOtelLoggerProvider, emitOtelLog, resetOtelLogBridge } = await import(
      '@civitai/telemetry/otel-logs'
    );
    const { logs } = await import('@opentelemetry/api-logs');
    const batches: number[] = [];
    const provider = createOtelLoggerProvider({
      exporter: {
        export: (records, done) => {
          batches.push(records.length);
          done({ code: 1, error: new Error('collector unreachable') });
        },
        shutdown: async () => undefined,
        forceFlush: async () => undefined,
      },
    });
    vi.stubEnv('OTEL_LOGS_ENABLED', 'true');
    vi.stubEnv('OTEL_LOG_LEVEL', 'error');
    // What NodeSDK's constructor does when OTEL_LOG_LEVEL is set.
    diag.setLogger(new DiagConsoleLogger(), { logLevel: DiagLogLevel.ERROR });
    if (reroute) expect(keepOtelDiagOffConsoleBackstop()).toBe(true);
    logs.setGlobalLoggerProvider(provider);
    resetOtelLogBridge();

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const backstop = installConsoleOtlpBackstop({
      emit: (body, record) => emitOtelLog(body, { ...record, logSource: record.source }),
    })!;
    try {
      console.error('one raw line');
      await provider.forceFlush();
      await provider.forceFlush();
      await provider.forceFlush();
      return { batches: [...batches], stderrCalls: spy.mock.calls.length };
    } finally {
      backstop.uninstall();
      spy.mockRestore();
      logs.disable();
      resetOtelLogBridge();
      await provider.shutdown();
    }
  }

  it('keeps export-failure reports out of the next export', async () => {
    const { batches, stderrCalls } = await exportFailuresAcrossThreeFlushes({ reroute: true });

    expect(batches).toEqual([1]);
    // The raw line plus at least one diag report, all still on stderr.
    expect(stderrCalls).toBeGreaterThanOrEqual(2);
  });

  it('control: without it, each failed export queues a record into the next one', async () => {
    const { batches } = await exportFailuresAcrossThreeFlushes({ reroute: false });

    expect(batches).toEqual([1, 1, 1]);
  });

  it('does nothing when OTEL_LOG_LEVEL is unset (no diag logger to replace)', () => {
    vi.stubEnv('OTEL_LOG_LEVEL', '');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(keepOtelDiagOffConsoleBackstop()).toBe(false);
      diag.error('not printed');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
