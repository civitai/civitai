import { afterAll, describe, expect, it, vi } from 'vitest';
import { createFliptClient, type FliptFeatureFlags } from '@civitai/flipt';
import type * as FliptClient from '~/server/flipt/client';
import sourceSnapshot from '../../__tests__/fixtures/flipt-store-scope.snapshot.json';
import {
  deriveSnapshotFromFlagShape,
  startFliptFixtureServer,
  type FliptFixtureServer,
} from '../../__tests__/fixtures/flipt-fixture-server';

/**
 * The content-levels gate (`isSharedDocLevelsOn`, `withDocLevelGate`) against the REAL
 * `@civitai/flipt` client and wasm engine, served a real evaluation snapshot over localhost.
 *
 * The four flag states production can be in: ON, explicitly OFF, the key missing from the
 * snapshot, and no client at all (Flipt unreachable at init, no stored snapshot). The gate FAILS
 * CLOSED: only an explicit OFF turns levels off. The rater's read (`isSharedDocLevelsKnownOn`) is
 * the opposite: only an explicit ON starts rating an app.
 */

const FLAG = 'app-blocks-shared-doc-levels';
const APP = 'ab_REALFLIPT';

const holder = vi.hoisted(() => ({ flipt: null as FliptFeatureFlags | null }));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: (flag: string, entityId?: string, context?: Record<string, string>) =>
    holder.flipt!.isEnabled(flag, entityId, context),
  readFliptBoolean: (flag: string, entityId?: string, context?: Record<string, string>) =>
    holder.flipt!.readBoolean(flag, entityId, context),
}));

import {
  isSharedDocLevelsKnownOn,
  isSharedDocLevelsOn,
  withDocLevelGate,
} from '~/server/services/apps/doc-levels';
import type { StorageAccess } from '~/server/services/apps/doc-store-access';

type Scenario = 'on' | 'off' | 'missing' | 'no-client';

const servers: FliptFixtureServer[] = [];

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
  } else {
    const server = await startFliptFixtureServer(snapshotFor(scenario));
    servers.push(server);
    url = server.url;
  }
  holder.flipt = createFliptClient({
    url,
    clientToken: 'test-token',
    environment: 'civitai-app',
    // The global test setup pins this flag OFF through FLIPT_LOCAL_OVERRIDES; this suite is about
    // what real Flipt answers, so it must not see that override.
    localOverrides: {},
    log: () => undefined,
    onInitError: () => undefined,
    onEvalError: () => undefined,
  });
}

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

const access = { ctx: { appId: APP, ns: 'prod', viewerUid: 9 } } as unknown as StorageAccess;
const claims = { maxBrowsingLevel: 31, viewerBrowsingLevel: 3 };

describe('the instrument: the real client reaches each state', () => {
  it('reads OFF as false, a missing key and no client as null', async () => {
    await useFlipt('off');
    await expect(holder.flipt!.readBoolean(FLAG, APP)).resolves.toBe(false);
    await useFlipt('on');
    await expect(holder.flipt!.readBoolean(FLAG, APP)).resolves.toBe(true);
    await useFlipt('missing');
    await expect(holder.flipt!.readBoolean(FLAG, APP)).resolves.toBeNull();
    await useFlipt('no-client');
    await expect(holder.flipt!.readBoolean(FLAG, APP)).resolves.toBeNull();
    expect(holder.flipt!.getClientSync()).toBeNull();
  });
});

describe('the gate fails closed', () => {
  it.each<[Scenario, boolean]>([
    ['on', true],
    ['off', false],
    ['missing', true],
    ['no-client', true],
  ])('flag %s → levels on = %s', async (scenario, want) => {
    await useFlipt(scenario);
    await expect(isSharedDocLevelsOn(APP)).resolves.toBe(want);
  });

  it.each<[Scenario, boolean]>([
    ['on', true],
    ['off', false],
    ['missing', true],
    ['no-client', true],
  ])('flag %s → the storage routes gate reads = %s', async (scenario, gated) => {
    await useFlipt(scenario);
    const out = await withDocLevelGate(access, claims);
    if (gated) {
      expect(out.ctx).toEqual({
        appId: APP,
        ns: 'prod',
        viewerUid: 9,
        levels: { viewerLevel: 3, domainLevel: 31 },
      });
    } else {
      expect(out).toBe(access);
    }
  });
});

describe('the rater reads only an explicit ON', () => {
  it.each<[Scenario, boolean]>([
    ['on', true],
    ['off', false],
    ['missing', false],
    ['no-client', false],
  ])('flag %s → rate the app = %s', async (scenario, want) => {
    await useFlipt(scenario);
    await expect(isSharedDocLevelsKnownOn(APP)).resolves.toBe(want);
  });
});
