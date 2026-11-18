import { describe, expect, it } from 'vitest';
import type { Adapter } from '~/server/registry-adapter/protocol';
import { createRegistryServer, keepAliveTimeoutFromEnv } from '~/server/registry-adapter/serve';

// Rationale for the 100 s default: see DEFAULT_KEEP_ALIVE_TIMEOUT_MS in serve.ts.

async function* nothing(): AsyncGenerator<never> {
  yield* [];
}

const source: Adapter = {
  namespace: 'apps.civitai.com',
  serves: () => false,
  // eslint-disable-next-line local-rules/no-unbounded-paging-fake -- never called: nothing is served
  snapshot: async () => ({ cursor: 'c1', entities: [] }),
  changes: async () => nothing(),
};

describe('keepAliveTimeoutFromEnv', () => {
  it('defaults to 100 s, above the 90 s idle timeout of the proxy in front', () => {
    expect(keepAliveTimeoutFromEnv({})).toBe(100_000);
    expect(keepAliveTimeoutFromEnv({})).toBeGreaterThan(90_000);
  });

  it('takes KEEP_ALIVE_TIMEOUT in milliseconds', () => {
    expect(keepAliveTimeoutFromEnv({ KEEP_ALIVE_TIMEOUT: '123456' })).toBe(123_456);
  });

  it('falls back to the default on an unset, empty, zero, negative or non-numeric value', () => {
    for (const raw of [undefined, '', '0', '-5', 'soon']) {
      expect(keepAliveTimeoutFromEnv({ KEEP_ALIVE_TIMEOUT: raw })).toBe(100_000);
    }
  });
});

describe('createRegistryServer timeouts', () => {
  it('holds idle connections for 100 s by default, with headersTimeout above it', () => {
    const server = createRegistryServer(source);
    expect(server.keepAliveTimeout).toBe(100_000);
    expect(server.headersTimeout).toBe(101_000);
  });

  it('applies the configured keepAliveTimeout and keeps headersTimeout above it', () => {
    const server = createRegistryServer(source, { keepAliveTimeoutMs: 123_456 });
    expect(server.keepAliveTimeout).toBe(123_456);
    expect(server.headersTimeout).toBe(124_456);
  });
});
