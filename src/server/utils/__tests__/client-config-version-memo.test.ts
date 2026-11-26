import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetVersionParseCacheForTests,
  __versionParseCacheSizeForTests,
  callsRemovedProcedure,
  clientNeedsUpdate,
} from '~/server/utils/client-config';

// `clientNeedsUpdate` and `callsRemovedProcedure` memoise version parsing per raw string. These pin
// that the answer depends on THIS call's header and forced version, never on what an earlier call
// put in the memo, and that the memo stays bounded.

const web = (version?: unknown, date?: string) =>
  ({
    'x-client': 'web',
    ...(version !== undefined ? { 'x-client-version': version } : {}),
    ...(date !== undefined ? { 'x-client-date': date } : {}),
  } as never);

const removed = [{ procedure: undefined }];
const present = [{ procedure: {} }];

beforeEach(() => __resetVersionParseCacheForTests());

describe('clientNeedsUpdate', () => {
  it.each([
    // [header version, forced version, expected]
    ['5.0.10', '5.0.20', true],
    ['5.0.20', '5.0.20', false],
    ['5.0.30', '5.0.20', false],
    ['6.1.0', '5.9.99', false],
    ['5.0.20-beta.1', '5.0.20', true],
    ['v5.0.10', '5.0.20', true],
    [' 5.0.40 ', '5.0.20', false],
    ['not-a-version', '5.0.20', true],
    ['5.0', '5.0.20', true],
    ['', '5.0.20', true],
    [undefined, '5.0.20', true],
    [['5.0.30', '5.0.31'], '5.0.20', true],
  ] as const)('header %j against forced %j is %s', (header, forced, expected) => {
    expect(clientNeedsUpdate(web(header), { version: forced })).toBe(expected);
    // Second call answers from the memo and must agree.
    expect(clientNeedsUpdate(web(header), { version: forced })).toBe(expected);
  });

  it('falls back to the date rule when the forced version is missing or unparseable', () => {
    const date = '2026-01-15T00:00:00.000Z';
    const before = String(Date.parse('2026-01-01T00:00:00.000Z'));
    const after = String(Date.parse('2026-02-01T00:00:00.000Z'));
    for (const version of [undefined, 'garbage']) {
      const client = { ...(version ? { version } : {}), date } as Record<string, string>;
      expect(clientNeedsUpdate(web('5.0.10', before), client)).toBe(true);
      expect(clientNeedsUpdate(web('5.0.10', after), client)).toBe(false);
      expect(clientNeedsUpdate(web('5.0.10'), client)).toBe(true);
    }
    expect(clientNeedsUpdate(web('5.0.10'), {})).toBe(false);
  });

  it('answers each header on its own, whichever was parsed first', () => {
    const forced = { version: '5.0.20' };
    const order = ['5.0.11', '5.0.37', '5.0.12', 'junk', '5.0.38', '5.0.11'];
    const expected = [true, false, true, true, false, true];
    expect(order.map((v) => clientNeedsUpdate(web(v), forced))).toEqual(expected);
  });

  it('follows a change of the forced version for an already-parsed header', () => {
    const header = web('5.0.25');
    expect(clientNeedsUpdate(header, { version: '5.0.20' })).toBe(false);
    expect(clientNeedsUpdate(header, { version: '5.0.30' })).toBe(true);
    expect(clientNeedsUpdate(header, { version: '5.0.24' })).toBe(false);
  });

  it('stays bounded under many distinct headers and keeps answering correctly', () => {
    const forced = { version: '7.0.500' };
    for (let i = 0; i < 1_000; i++) {
      expect(clientNeedsUpdate(web(`7.0.${i}`), forced)).toBe(i < 500);
    }
    expect(__versionParseCacheSizeForTests()).toBeGreaterThan(0);
    expect(__versionParseCacheSizeForTests()).toBeLessThanOrEqual(256);
  });

  it('does not memoise an over-long header, and still rejects it', () => {
    const long = `5.0.1-${'x'.repeat(300)}`;
    expect(clientNeedsUpdate(web(long), { version: '5.0.20' })).toBe(true);
    // Only the forced version was memoised.
    expect(__versionParseCacheSizeForTests()).toBe(1);
  });
});

describe('callsRemovedProcedure', () => {
  it.each([
    // [header version, server version, calls, expected]
    ['5.0.10', '5.0.20', removed, true],
    ['5.0.20', '5.0.20', removed, false],
    ['5.0.33', '5.0.20', removed, false],
    ['5.0.10', '5.0.20', present, false],
    ['5.0.10', undefined, removed, false],
    ['5.0.10', 'dev-build', removed, false],
    ['nope', '5.0.20', removed, false],
    [undefined, '5.0.20', removed, false],
    [['5.0.1', '5.0.2'], '5.0.20', removed, false],
  ] as const)(
    'header %j against server %j with calls %j is %s',
    (header, server, calls, expected) => {
      expect(callsRemovedProcedure(web(header), calls, server)).toBe(expected);
      expect(callsRemovedProcedure(web(header), calls, server)).toBe(expected);
    }
  );

  it('answers each header on its own, whichever was parsed first', () => {
    const order = ['4.9.1', '5.0.41', '4.9.2', '5.0.42'];
    expect(order.map((v) => callsRemovedProcedure(web(v), removed, '5.0.20'))).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });
});
