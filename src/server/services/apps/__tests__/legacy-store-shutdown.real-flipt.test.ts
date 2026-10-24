import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFliptClient, type FliptFeatureFlags } from '@civitai/flipt';
import sourceSnapshot from '../../__tests__/fixtures/flipt-store-scope.snapshot.json';
import {
  deriveSnapshotFromFlagShape,
  startFliptFixtureServer,
  type FliptFixtureServer,
} from '../../__tests__/fixtures/flipt-fixture-server';

/**
 * `areLegacyStoresRemoved` against the REAL `@civitai/flipt` client and wasm engine, served a
 * real evaluation snapshot over localhost, across the fail-closed cutoff (2026-11-10T00:00Z).
 *
 * The four flag states are the ones production can be in: the flag ON, explicitly OFF, the key
 * missing from the snapshot, and no client at all (Flipt unreachable at init). Before the cutoff
 * only ON removes the stores; from the cutoff on, only an explicit OFF keeps them.
 */

const FLAG = 'app-blocks-legacy-stores-removed';
const BEFORE = new Date('2026-11-09T23:59:59.999Z');
const AT = new Date('2026-11-10T00:00:00.000Z');
const LATER = new Date('2027-01-15T12:00:00.000Z');

const holder = vi.hoisted(() => ({ flipt: null as FliptFeatureFlags | null }));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: (flag: string, entityId?: string, context?: Record<string, string>) =>
    holder.flipt!.isEnabled(flag, entityId, context),
  isFliptSync: (flag: string, entityId?: string, context?: Record<string, string>) =>
    holder.flipt!.isEnabledSync(flag, entityId, context),
  ensureFliptInitialized: () => holder.flipt!.ensureInitialized(),
}));

import { areLegacyStoresRemoved } from '~/server/services/apps/legacy-store-shutdown';

type Scenario = 'on' | 'off' | 'missing' | 'no-client';

const servers: FliptFixtureServer[] = [];
let current: FliptFixtureServer | null = null;

function snapshotFor(scenario: Exclude<Scenario, 'no-client'>) {
  const flags =
    scenario === 'missing'
      ? [{ key: 'some-other-flag', enabled: true }]
      : [{ key: FLAG, enabled: scenario === 'on' }];
  return deriveSnapshotFromFlagShape(sourceSnapshot as never, 'app-blocks-enabled', flags);
}

async function useFlipt(scenario: Scenario) {
  let url: string;
  if (scenario === 'no-client') {
    // A port that was listening a moment ago and is now closed: init is refused.
    const gone = await startFliptFixtureServer({});
    await gone.close();
    url = gone.url;
    current = null;
  } else {
    current = await startFliptFixtureServer(snapshotFor(scenario));
    servers.push(current);
    url = current.url;
  }
  holder.flipt = createFliptClient({
    url,
    clientToken: 'test-token',
    environment: 'civitai-app',
    log: () => undefined,
    onInitError: () => undefined,
    onEvalError: () => undefined,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

describe('the instrument: what the real client reports for each state', () => {
  it('isFlipt cannot tell an explicit OFF from a missing key, isFliptSync can', async () => {
    vi.setSystemTime(BEFORE);

    await useFlipt('off');
    await holder.flipt!.ensureInitialized();
    expect(current!.received.length).toBeGreaterThan(0);
    await expect(holder.flipt!.isEnabled(FLAG)).resolves.toBe(false);
    expect(holder.flipt!.isEnabledSync(FLAG)).toBe(false);

    await useFlipt('missing');
    await holder.flipt!.ensureInitialized();
    expect(current!.received.length).toBeGreaterThan(0);
    await expect(holder.flipt!.isEnabled(FLAG)).resolves.toBe(false);
    expect(holder.flipt!.isEnabledSync(FLAG)).toBeNull();

    await useFlipt('on');
    await holder.flipt!.ensureInitialized();
    expect(holder.flipt!.isEnabledSync(FLAG)).toBe(true);

    await useFlipt('no-client');
    await holder.flipt!.ensureInitialized();
    expect(holder.flipt!.getClientSync()).toBeNull();
    expect(holder.flipt!.isEnabledSync(FLAG)).toBeNull();
  });
});

describe('areLegacyStoresRemoved across the cutoff', () => {
  const MATRIX: [Scenario, Date, boolean][] = [
    ['on', BEFORE, true],
    ['on', AT, true],
    ['on', LATER, true],
    ['off', BEFORE, false],
    ['off', AT, false],
    ['off', LATER, false],
    ['missing', BEFORE, false],
    ['missing', AT, true],
    ['missing', LATER, true],
    ['no-client', BEFORE, false],
    ['no-client', AT, true],
    ['no-client', LATER, true],
  ];

  it.each(MATRIX.map(([s, t, want]) => [s, t.toISOString(), want, t] as const))(
    'flag %s at %s → removed=%s',
    async (scenario, _iso, want, time) => {
      vi.setSystemTime(time);
      await useFlipt(scenario);

      await expect(areLegacyStoresRemoved()).resolves.toBe(want);
    }
  );
});
