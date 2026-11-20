// Forwards raw `console.*` output to the structured-log sink, so a line that exists only on stdout
// (a stack trace from `console.error(err)`, a library warning, a startup banner) is also in the
// OTLP log stream. Server-only: installed from `src/instrumentation.node.ts`, never imported by
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
import {
  emitConsoleLog,
  MAX_FORWARDED_LOG_BODY,
  type ConsoleLogSource,
} from '~/server/logging/structured-log-sink';

export const CONSOLE_BACKSTOP_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type ConsoleMethod = (typeof CONSOLE_BACKSTOP_METHODS)[number];

const SEVERITY: Record<ConsoleMethod, 'error' | 'warn' | 'info'> = {
  error: 'error',
  warn: 'warn',
  log: 'info',
  info: 'info',
  debug: 'info',
};

/**
 * Records per second per process; calls over it are still written to stdout, only counted.
 *
 * The OTLP queue this feeds also carries the app logger's alert-feeding records, and it exports at
 * most 512 records per batch. 50/s keeps a console-spamming library under a tenth of one batch,
 * while sitting well above the expected unforwarded console rate (about one line per second).
 */
export const CONSOLE_BACKSTOP_MAX_RECORDS_PER_SECOND = 50;

export type ConsoleRecord = {
  source: Extract<ConsoleLogSource, 'console'>;
  name: string;
  type: string;
};

export type ConsoleBackstopOptions = {
  /** Receives one already-formatted body per forwarded call (`emitConsoleLog` in production). */
  emit: (body: string, record: ConsoleRecord) => void;
  /** Called once per call dropped by the rate cap. */
  onDrop?: () => void;
  maxRecordsPerSecond?: number;
  now?: () => number;
  /** The console to wrap; the global one unless a test passes its own. */
  target?: Console;
};

export type ConsoleBackstop = {
  /** Calls dropped by the rate cap since install. */
  dropped: () => number;
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

  const max = opts.maxRecordsPerSecond ?? CONSOLE_BACKSTOP_MAX_RECORDS_PER_SECOND;
  const now = opts.now ?? Date.now;
  let windowSecond = Number.NaN;
  let admittedInWindow = 0;
  let dropped = 0;

  const admit = (): boolean => {
    const second = Math.floor(now() / 1000);
    if (second !== windowSecond) {
      windowSecond = second;
      admittedInWindow = 0;
    }
    if (admittedInWindow < max) {
      admittedInWindow++;
      return true;
    }
    dropped++;
    opts.onDrop?.();
    return false;
  };

  const forward = (method: ConsoleMethod, args: unknown[]) => {
    try {
      if (!admit()) return;
      withConsoleForwardingSuppressed(() => {
        const body = stripVTControlCharacters(format(...args)).slice(0, MAX_FORWARDED_LOG_BODY);
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
    dropped: () => dropped,
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
 * The production install: only when OTLP logs are on, after the logger provider and `NodeSDK` are
 * set up. A no-op on a second call.
 */
export function armConsoleOtlpBackstop(
  env: Record<string, string | undefined> = process.env
): ConsoleBackstop | undefined {
  if (env.OTEL_LOGS_ENABLED !== 'true') return undefined;
  keepOtelDiagOffConsoleBackstop();
  return installConsoleOtlpBackstop({
    emit: emitConsoleLog,
    onDrop: () => otelConsoleRecordsDroppedCounter.inc(),
  });
}
