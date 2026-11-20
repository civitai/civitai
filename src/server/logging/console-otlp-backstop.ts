// Forwards raw `console.*` output to the structured-log sink, so a line that exists only on stdout
// (a stack trace from `console.error(err)`, a library warning) is also in the OTLP log stream.
// Lines printed before it is installed (most of boot) stay stdout-only. Server-only: installed from `src/instrumentation.node.ts`, never imported by
// a module the client or edge bundles reach.
//
// Writers that already forward their line, or keep it on stdout on purpose, wrap their console call
// in `withConsoleForwardingSuppressed` (`@civitai/axiom/console-forwarding`), and the wrapper below
// skips any call made while that mark is up. The wrapper raises the same mark around its own emit,
// so a console call made synchronously by the sink cannot re-enter it.
import { format, stripVTControlCharacters } from 'node:util';
import { diag, DiagConsoleLogger, type DiagLogger } from '@opentelemetry/api';
import { diagLogLevelFromString, getStringFromEnv } from '@opentelemetry/core';
import {
  isConsoleForwardingSuppressed,
  withConsoleForwardingSuppressed,
} from '@civitai/axiom/console-forwarding';
import { otelConsoleRecordsDroppedCounter } from '@civitai/telemetry/otel-logs';
import { emitConsoleLog, type ConsoleLogSource } from '~/server/logging/structured-log-sink';

export const CONSOLE_BACKSTOP_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type ConsoleMethod = (typeof CONSOLE_BACKSTOP_METHODS)[number];

const SEVERITY: Record<ConsoleMethod, 'error' | 'warn' | 'info'> = {
  error: 'error',
  warn: 'warn',
  log: 'info',
  info: 'info',
  debug: 'info',
};

/*
 * Budgets, per process and per second. A call over either is still written to stdout and is only
 * counted. The OTLP export queue this feeds also carries the app logger's alert-feeding records,
 * and many processes run this at once, so the total is these figures times the process count.
 *
 * - 50 records/s: under a tenth of one 512-record export batch, and well above the expected
 *   unforwarded console rate (about one line per second).
 * - 64 KiB/s: a library printing large objects reaches the byte budget long before the record
 *   budget (32 full-size bodies), so a burst costs bandwidth in proportion to records, not size.
 * - 2048-character body: room for a full stack trace; a longer line is cut (stdout keeps it all).
 *   Lower than the createLogger cap because these lines are unstructured and may be anything.
 */
export const CONSOLE_BACKSTOP_MAX_RECORDS_PER_SECOND = 50;
export const CONSOLE_BACKSTOP_MAX_BYTES_PER_SECOND = 64 * 1024;
export const CONSOLE_RECORD_BODY_MAX = 2048;

// The formatted string is cut to this before colour codes are stripped, so a huge argument costs
// a bounded strip. A multiple of the cap leaves room for the codes that the strip removes.
const PRE_STRIP_SLICE = CONSOLE_RECORD_BODY_MAX * 4;

/** One record's body: formatted as console formats it, colour codes stripped, cut to the cap. */
export function consoleRecordBody(args: unknown[]): string {
  const formatted = format(...args).slice(0, PRE_STRIP_SLICE);
  return stripVTControlCharacters(formatted).slice(0, CONSOLE_RECORD_BODY_MAX);
}

export type ConsoleRecord = {
  source: Extract<ConsoleLogSource, 'console'>;
  name: string;
  type: string;
};

export type ConsoleBackstopOptions = {
  /** Receives one already-formatted body per forwarded call (`emitConsoleLog` in production). */
  emit: (body: string, record: ConsoleRecord) => void;
  /** Called once per call dropped by either budget. */
  onDrop?: () => void;
  maxRecordsPerSecond?: number;
  maxBytesPerSecond?: number;
  now?: () => number;
  /** The console to wrap; the global one unless a test passes its own. */
  target?: Console;
};

export type ConsoleBackstop = {
  /** Put the original methods back, unless something has replaced the wrappers since. Tests only. */
  uninstall: () => void;
};

// On the console object itself, so every bundled copy of this module, and a second run of
// instrumentation (HMR), sees an existing install.
const INSTALLED = Symbol.for('@civitai/console-otlp-backstop.installed');

type MarkedConsole = Console & { [INSTALLED]?: true };

/**
 * Wrap the console methods so each call ALSO sends one record to `emit`. The original method runs
 * first, with the same `this` and arguments, and its return value or throw is the caller's; nothing
 * after it can throw. Returns undefined when the console is already wrapped.
 */
export function installConsoleOtlpBackstop(
  opts: ConsoleBackstopOptions
): ConsoleBackstop | undefined {
  const target = (opts.target ?? console) as MarkedConsole;
  if (target[INSTALLED]) return undefined;

  const maxRecords = opts.maxRecordsPerSecond ?? CONSOLE_BACKSTOP_MAX_RECORDS_PER_SECOND;
  const maxBytes = opts.maxBytesPerSecond ?? CONSOLE_BACKSTOP_MAX_BYTES_PER_SECOND;
  const now = opts.now ?? Date.now;
  let windowSecond = Number.NaN;
  let recordsInWindow = 0;
  let bytesInWindow = 0;

  const forward = (method: ConsoleMethod, args: unknown[]) => {
    try {
      const second = Math.floor(now() / 1000);
      if (second !== windowSecond) {
        windowSecond = second;
        recordsInWindow = 0;
        bytesInWindow = 0;
      }
      // Checked before formatting, so a call over the record budget costs no format.
      if (recordsInWindow >= maxRecords) return opts.onDrop?.();
      withConsoleForwardingSuppressed(() => {
        const body = consoleRecordBody(args);
        const bytes = Buffer.byteLength(body);
        if (bytesInWindow + bytes > maxBytes) return opts.onDrop?.();
        recordsInWindow++;
        bytesInWindow += bytes;
        opts.emit(body, { source: 'console', name: 'console', type: SEVERITY[method] });
      });
    } catch {}
  };

  const originals = new Map<ConsoleMethod, Console[ConsoleMethod]>();
  const wrappers = new Map<ConsoleMethod, Console[ConsoleMethod]>();
  for (const method of CONSOLE_BACKSTOP_METHODS) {
    const original = target[method];
    const wrapper = function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      if (!isConsoleForwardingSuppressed()) forward(method, args);
      return result;
    };
    originals.set(method, original);
    wrappers.set(method, wrapper);
    target[method] = wrapper;
  }
  Object.defineProperty(target, INSTALLED, { value: true, configurable: true });

  return {
    uninstall: () => {
      for (const method of CONSOLE_BACKSTOP_METHODS) {
        if (target[method] === wrappers.get(method)) target[method] = originals.get(method)!;
      }
      delete target[INSTALLED];
    },
  };
}

/**
 * Re-register OTel's console diag logger (which `NodeSDK` installs when `OTEL_LOG_LEVEL` is set)
 * with every line written under `withConsoleForwardingSuppressed`. Same level, same console calls,
 * so stdout is unchanged.
 *
 * 🔴 Required once the backstop is on: a failed export reports through `diag.error` from an async
 * continuation, where the wrapper's synchronous mark is down. Forwarded, that line would be queued
 * into the next export, which fails and reports again: one record per export, for as long as the
 * collector is unreachable. Call it after `new NodeSDK(...)`, which would otherwise replace it.
 */
export function keepOtelDiagOffConsoleBackstop(): boolean {
  const level = getStringFromEnv('OTEL_LOG_LEVEL');
  if (level == null) return false;
  const inner = new DiagConsoleLogger();
  const suppressed =
    (method: keyof DiagLogger) =>
    (...args: Parameters<DiagLogger[keyof DiagLogger]>) =>
      withConsoleForwardingSuppressed(() => inner[method](...args));
  const logger: DiagLogger = {
    error: suppressed('error'),
    warn: suppressed('warn'),
    info: suppressed('info'),
    debug: suppressed('debug'),
    verbose: suppressed('verbose'),
  };
  diag.setLogger(logger, {
    logLevel: diagLogLevelFromString(level),
    suppressOverrideMessage: true,
  });
  return true;
}

/**
 * The production install, after the logger provider and `NodeSDK` are set up. Off unless both
 * `OTEL_LOGS_ENABLED` and its own `OTEL_CONSOLE_BACKSTOP_ENABLED` are `'true'`, so it can be turned
 * off without turning off the OTLP copy of app-logger records. A no-op on a second call.
 */
export function armConsoleOtlpBackstop(
  env: Record<string, string | undefined> = process.env
): ConsoleBackstop | undefined {
  if (env.OTEL_LOGS_ENABLED !== 'true' || env.OTEL_CONSOLE_BACKSTOP_ENABLED !== 'true') {
    return undefined;
  }
  keepOtelDiagOffConsoleBackstop();
  return installConsoleOtlpBackstop({
    emit: emitConsoleLog,
    onDrop: () => otelConsoleRecordsDroppedCounter.inc(),
  });
}
