// The env timeout parser feeds pg's connection/query timeouts and the redis socket timeout. A value past
// Node's timer limit (2^31-1 ms) would be clamped by setTimeout to 1 ms, turning "very long" into "fail
// every call at once"; it is capped at the limit instead.
import { expect, test } from 'vitest';
import { envTimeoutMs } from '@/utils/env-timeout';

const MAX_TIMER_MS = 2_147_483_647;

test('unset or unparseable uses the default; zero or below turns the bound off', () => {
  expect(envTimeoutMs(undefined, 5_000)).toBe(5_000);
  expect(envTimeoutMs('', 5_000)).toBe(5_000);
  expect(envTimeoutMs('soon', 5_000)).toBe(5_000);
  expect(envTimeoutMs('0', 5_000)).toBeUndefined();
  expect(envTimeoutMs('-1', 5_000)).toBeUndefined();
  expect(envTimeoutMs('1234', 5_000)).toBe(1_234);
});

test('a value past the timer limit is capped at it, never left to clamp to 1 ms', () => {
  expect(envTimeoutMs(String(MAX_TIMER_MS + 1), 5_000)).toBe(MAX_TIMER_MS);
  expect(envTimeoutMs('1e12', 5_000)).toBe(MAX_TIMER_MS);
  expect(envTimeoutMs(String(MAX_TIMER_MS), 5_000)).toBe(MAX_TIMER_MS);
});
