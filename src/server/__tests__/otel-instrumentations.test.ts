import { afterEach, describe, expect, it } from 'vitest';
import type { RequestOptions } from 'node:http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { buildOtelInstrumentations } from '~/server/otel-instrumentations';

// What these pin: the list handed to the OTEL NodeSDK in instrumentation.node.ts. An unset
// OTEL_HTTP_INSTRUMENTATION must keep today's behaviour (inbound HttpInstrumentation ON), and
// `off` must leave it out entirely — so a deployment can drop the per-request server span
// without a code change.

const built: unknown[] = [];

function build(env: NodeJS.ProcessEnv) {
  const list = buildOtelInstrumentations(env);
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

describe('buildOtelInstrumentations', () => {
  it('registers the inbound-only HttpInstrumentation when OTEL_HTTP_INSTRUMENTATION is unset', () => {
    const list = build({});
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
      expect(httpInstrumentations(build({ OTEL_HTTP_INSTRUMENTATION: value }))).toHaveLength(1);
    }
  );

  it.each(['off', 'OFF', ' off ', 'false', '0'])(
    'registers no instrumentation for OTEL_HTTP_INSTRUMENTATION=%j',
    (value) => {
      expect(build({ OTEL_HTTP_INSTRUMENTATION: value })).toEqual([]);
    }
  );

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
