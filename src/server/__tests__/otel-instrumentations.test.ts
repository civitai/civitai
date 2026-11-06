import { afterEach, describe, expect, it } from 'vitest';
import type { RequestOptions } from 'node:http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import {
  buildOtelInstrumentations,
  isHttpOutgoingPatchEnabled,
} from '~/server/otel-instrumentations';

// What these pin: the list handed to the OTEL NodeSDK in instrumentation.node.ts. An unset
// OTEL_HTTP_INSTRUMENTATION must keep today's behaviour (inbound HttpInstrumentation ON), and
// `off` must leave it out entirely — so a deployment can drop the per-request server span
// without a code change.

const built: unknown[] = [];

/** A partial environment. `NodeJS.ProcessEnv` requires NODE_ENV, which these functions never read. */
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

function build(vars: NodeJS.ProcessEnv) {
  const list = buildOtelInstrumentations(vars);
  built.push(...list);
  return list;
}

afterEach(() => {
  // Constructing HttpInstrumentation patches node:http; undo it so no other test in this
  // worker runs against a patched module.
  for (const inst of built.splice(0)) {
    if (inst instanceof HttpInstrumentation) inst.disable();
  }
});

function httpInstrumentations(list: unknown[]): HttpInstrumentation[] {
  return list.filter((i): i is HttpInstrumentation => i instanceof HttpInstrumentation);
}

/** The one HttpInstrumentation in `list`; throws unless there is exactly one. */
function onlyHttp(list: unknown[]): HttpInstrumentation {
  const http = httpInstrumentations(list);
  if (http.length !== 1) throw new Error(`expected one HttpInstrumentation, got ${http.length}`);
  return http[0] as HttpInstrumentation;
}

describe('buildOtelInstrumentations', () => {
  it('registers the inbound-only HttpInstrumentation when OTEL_HTTP_INSTRUMENTATION is unset', () => {
    const list = build(env({}));
    const http = httpInstrumentations(list);

    expect(list).toHaveLength(1);
    expect(http).toHaveLength(1);
    // Still inbound-only: every outgoing request is ignored, incoming ones are not filtered.
    const config = http[0].getConfig();
    expect(config.ignoreOutgoingRequestHook?.({} as RequestOptions)).toBe(true);
    expect(config.ignoreIncomingRequestHook).toBeUndefined();
  });

  it.each(['on', 'true', '1', ''])(
    'keeps it registered for OTEL_HTTP_INSTRUMENTATION=%j',
    (value) => {
      expect(httpInstrumentations(build(env({ OTEL_HTTP_INSTRUMENTATION: value })))).toHaveLength(
        1
      );
    }
  );

  it.each(['off', 'OFF', ' off ', 'false', '0'])(
    'registers no instrumentation for OTEL_HTTP_INSTRUMENTATION=%j',
    (value) => {
      expect(build(env({ OTEL_HTTP_INSTRUMENTATION: value }))).toEqual([]);
    }
  );

  // OTEL_HTTP_OUTGOING: unset must leave the option exactly as before the switch existed (absent),
  // so the default config is today's; off must stop the outbound patch while keeping the inbound
  // instrumentation and the ignore hook unchanged.
  it('leaves disableOutgoingRequestInstrumentation unset when OTEL_HTTP_OUTGOING is unset', () => {
    const http = onlyHttp(build(env({})));
    expect('disableOutgoingRequestInstrumentation' in http.getConfig()).toBe(false);
  });

  it.each(['on', 'true', '1', '', 'patched'])(
    'keeps the outbound patch for OTEL_HTTP_OUTGOING=%j',
    (value) => {
      const http = onlyHttp(build(env({ OTEL_HTTP_OUTGOING: value })));
      expect(http.getConfig().disableOutgoingRequestInstrumentation).toBeUndefined();
      expect(isHttpOutgoingPatchEnabled(env({ OTEL_HTTP_OUTGOING: value }))).toBe(true);
    }
  );

  it.each(['off', 'OFF', ' off ', 'false', '0'])(
    'stops patching outbound calls, and only that, for OTEL_HTTP_OUTGOING=%j',
    (value) => {
      const list = build(env({ OTEL_HTTP_OUTGOING: value }));
      expect(list).toHaveLength(1);
      const http = onlyHttp(list);
      const config = http.getConfig();
      expect(config.disableOutgoingRequestInstrumentation).toBe(true);
      expect(config.disableIncomingRequestInstrumentation).toBeUndefined();
      expect(config.ignoreOutgoingRequestHook?.({} as RequestOptions)).toBe(true);
      expect(config.ignoreIncomingRequestHook).toBeUndefined();
      expect(isHttpOutgoingPatchEnabled(env({ OTEL_HTTP_OUTGOING: value }))).toBe(false);
    }
  );

  it('registers nothing when the instrumentation is off, whatever OTEL_HTTP_OUTGOING says', () => {
    expect(build(env({ OTEL_HTTP_INSTRUMENTATION: 'off', OTEL_HTTP_OUTGOING: 'off' }))).toEqual([]);
    expect(build(env({ OTEL_HTTP_INSTRUMENTATION: 'off', OTEL_HTTP_OUTGOING: 'on' }))).toEqual([]);
  });

  it('reads process.env by default', () => {
    const saved = process.env.OTEL_HTTP_INSTRUMENTATION;
    try {
      process.env.OTEL_HTTP_INSTRUMENTATION = 'off';
      expect(buildOtelInstrumentations()).toEqual([]);
      delete process.env.OTEL_HTTP_INSTRUMENTATION;
      const list = buildOtelInstrumentations();
      built.push(...list);
      expect(httpInstrumentations(list)).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.OTEL_HTTP_INSTRUMENTATION;
      else process.env.OTEL_HTTP_INSTRUMENTATION = saved;
    }
  });
});
