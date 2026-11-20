import { styleText } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { setStructuredLogSink, structuredLogSink } from '~/server/logging/structured-log-sink';
import { createLogger, MAX_FORWARDED_LOG_BODY } from '~/utils/logging';

const NAME = 'otel-bridge-test-logger';
const RED = '\x1b[31mred text\x1b[39m';

let logSpy: ReturnType<typeof vi.spyOn>;
let previousEmit: typeof structuredLogSink.emitLog;

beforeEach(() => {
  previousEmit = structuredLogSink.emitLog;
  setEnv({ LOGGING: [NAME] });
  // A test worker's stdout is not a TTY, so without this the logger name is never coloured.
  vi.stubEnv('FORCE_COLOR', '1');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  structuredLogSink.emitLog = previousEmit;
  logSpy.mockRestore();
  vi.unstubAllEnvs();
});

describe('createLogger', () => {
  it('sends one uncoloured record per call to the registered sink', () => {
    const emit = vi.fn();
    setStructuredLogSink(emit);

    createLogger(NAME, 'magenta')('processed', RED, { batch: 3 }, 42);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      `${NAME} processed red text { batch: 3 } 42`,
      { type: 'info', name: NAME, logSource: 'createLogger' },
      'civitai-console'
    );
  });

  it('writes stdout exactly as before', () => {
    setStructuredLogSink(vi.fn());

    createLogger(NAME, 'magenta')('processed', RED, 42);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(`\x1b[35m${NAME}\x1b[39m`, 'processed', RED, 42);
  });

  it('only prints when no sink is registered', () => {
    structuredLogSink.emitLog = undefined;

    expect(() => createLogger(NAME)('no sink')).not.toThrow();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('neither throws nor skips stdout when the sink throws', () => {
    setStructuredLogSink(() => {
      throw new Error('sink down');
    });

    expect(() => createLogger(NAME)('still logs')).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(styleText('green', NAME), 'still logs');
  });

  it('keeps a forward: false logger on stdout only', () => {
    const emit = vi.fn();
    setStructuredLogSink(emit);

    createLogger(NAME, 'blue', { forward: false })('SELECT 1');

    expect(emit).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(styleText('blue', NAME), 'SELECT 1');
  });

  it('cuts a forwarded body to the cap and leaves stdout whole', () => {
    const emit = vi.fn();
    setStructuredLogSink(emit);
    const long = 'x'.repeat(MAX_FORWARDED_LOG_BODY * 2 + 17);

    createLogger(NAME)(long);

    const body = emit.mock.calls[0][0] as string;
    expect(body).toHaveLength(MAX_FORWARDED_LOG_BODY);
    expect(body.startsWith(`${NAME} xxx`)).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(styleText('green', NAME), long);
  });

  it('sends nothing for a logger LOGGING does not enable', () => {
    const emit = vi.fn();
    setStructuredLogSink(emit);

    createLogger('a-logger-not-in-logging')('quiet');

    expect(emit).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
