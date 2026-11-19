import type * as CivitaiFlipt from '@civitai/flipt';
import type * as FliptClient from '~/server/flipt/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import storeScopeSnapshot from './fixtures/flipt-store-scope.snapshot.json';
import { startFliptFixtureServer, type FliptFixtureServer } from './fixtures/flipt-fixture-server';

/**
 * `getComVersionTextHideMode` over the REAL Flipt client and wasm engine, served a snapshot from a
 * localhost server. Only an evaluated `false` may read as off; the client's other answers for the
 * same call (unknown key, nothing reachable) must read as on.
 */

const FLAG = 'com-face-version-text-hide';

type RealFlipt = ReturnType<typeof CivitaiFlipt.createFliptClient>;
const live = vi.hoisted(() => ({ client: undefined as RealFlipt | undefined }));

// Each case gets its own real client; the module the helper imports forwards to it.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  ensureFliptInitialized: () => live.client!.ensureInitialized(),
  isFliptSync: (...args: Parameters<RealFlipt['isEnabledSync']>) =>
    live.client!.isEnabledSync(...args),
}));

/** A plain global boolean, in the shape of the captured snapshot's flags. */
function snapshotWith(flags: { key: string; enabled: boolean }[]) {
  const [template] = storeScopeSnapshot.flags;
  return {
    namespace: storeScopeSnapshot.namespace,
    flags: flags.map(({ key, enabled }) => ({
      ...structuredClone(template),
      key,
      enabled,
      rules: [],
      rollouts: [],
    })),
    digest: 'com-face-version-text-hide',
  };
}

const { comVersionTextJobsEnabled, getComVersionTextHideMode } = await import(
  '~/server/services/com-face-version-text-flag'
);

const servers: FliptFixtureServer[] = [];
afterAll(() => Promise.all(servers.map((server) => server.close())));

async function modeServedBy(
  snapshot: unknown,
  read: () => Promise<unknown> = getComVersionTextHideMode
) {
  const server = await startFliptFixtureServer(snapshot);
  servers.push(server);
  return modeAt(server.url, read);
}

async function modeAt(url: string, read: () => Promise<unknown> = getComVersionTextHideMode) {
  const { createFliptClient } = await import('@civitai/flipt');
  live.client = createFliptClient({
    url,
    clientToken: 'test-token',
    environment: 'civitai-app',
    log: () => undefined,
    onInitError: (e) => {
      throw e;
    },
  });
  return read();
}

describe('getComVersionTextHideMode over the real Flipt client', () => {
  let deadUrl: string;
  beforeAll(async () => {
    const server = await startFliptFixtureServer({});
    deadUrl = server.url;
    await server.close();
  });

  it('reads the flag present and disabled as off', async () => {
    await expect(modeServedBy(snapshotWith([{ key: FLAG, enabled: false }]))).resolves.toBe('off');
  });

  it('reads the flag present and enabled as on', async () => {
    await expect(modeServedBy(snapshotWith([{ key: FLAG, enabled: true }]))).resolves.toBe('on');
  });

  it('reads a snapshot without the key as on', async () => {
    await expect(
      modeServedBy(snapshotWith([{ key: 'some-other-flag', enabled: false }]))
    ).resolves.toBe('on');
  });

  it('reads an unreachable Flipt as on', async () => {
    await expect(modeAt(deadUrl)).resolves.toBe('on');
  });
});

describe('comVersionTextJobsEnabled over the real Flipt client', () => {
  const JOBS = 'com-face-version-text-jobs';
  let deadUrl: string;
  beforeAll(async () => {
    const server = await startFliptFixtureServer({});
    deadUrl = server.url;
    await server.close();
  });

  it('runs the jobs only when the flag is present and enabled', async () => {
    await expect(
      modeServedBy(snapshotWith([{ key: JOBS, enabled: true }]), comVersionTextJobsEnabled)
    ).resolves.toBe(true);
  });

  it('keeps them off when the flag is present and disabled', async () => {
    await expect(
      modeServedBy(snapshotWith([{ key: JOBS, enabled: false }]), comVersionTextJobsEnabled)
    ).resolves.toBe(false);
  });

  it('keeps them off when the key is missing', async () => {
    await expect(
      modeServedBy(
        snapshotWith([{ key: 'some-other-flag', enabled: true }]),
        comVersionTextJobsEnabled
      )
    ).resolves.toBe(false);
  });

  it('keeps them off when Flipt is unreachable', async () => {
    await expect(modeAt(deadUrl, comVersionTextJobsEnabled)).resolves.toBe(false);
  });
});
