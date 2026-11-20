import { afterAll, describe, expect, it, vi } from 'vitest';
import { createFliptClient, type FliptFeatureFlags } from '@civitai/flipt';
import type * as FliptClient from '~/server/flipt/client';
import type { SessionUser } from '~/types/session';
import sourceSnapshot from './fixtures/flipt-store-scope.snapshot.json';
import {
  deriveSnapshotFromFlagShape,
  startFliptFixtureServer,
  type FliptFixtureServer,
} from './fixtures/flipt-fixture-server';

/**
 * `readAppBlocksEnabled` against the REAL `@civitai/flipt` client and wasm engine, served a real
 * evaluation snapshot over localhost. It must tell an UNREADABLE flag (`null`: Flipt unreachable
 * with no snapshot, or the key missing) apart from one that reads `false`. `isAppBlocksEnabled`
 * answers `false` for both, which is what the registry private feed must not take for a
 * revocation (`private-feed.ts`, `runGateReadable`).
 */

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});

const holder = vi.hoisted(() => ({ flipt: null as FliptFeatureFlags | null }));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: (flag: string, entityId?: string, context?: Record<string, string>) =>
    holder.flipt!.isEnabled(flag, entityId, context),
  readFliptBoolean: (flag: string, entityId?: string, context?: Record<string, string>) =>
    holder.flipt!.readBoolean(flag, entityId, context),
}));

import { isAppBlocksEnabled, readAppBlocksEnabled } from '~/server/services/app-blocks-flag';

type Scenario = 'captured' | 'missing' | 'no-client';
const servers: FliptFixtureServer[] = [];

async function useFlipt(scenario: Scenario) {
  let url: string;
  if (scenario === 'no-client') {
    // A port that was listening a moment ago and is now closed: init is refused.
    const gone = await startFliptFixtureServer({});
    await gone.close();
    url = gone.url;
  } else {
    const snapshot =
      scenario === 'missing'
        ? deriveSnapshotFromFlagShape(sourceSnapshot as never, 'app-blocks-enabled', [
            { key: 'some-other-flag', enabled: true },
          ])
        : sourceSnapshot;
    const server = await startFliptFixtureServer(snapshot);
    servers.push(server);
    url = server.url;
  }
  holder.flipt = createFliptClient({
    url,
    clientToken: 'test-token',
    environment: 'civitai-app',
    localOverrides: {},
    log: () => undefined,
    onInitError: () => undefined,
    onEvalError: () => undefined,
  });
}

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

/** Minimal SessionUser: only the fields `buildFliptContext` reads. */
const sessionUser = (id: number, extra: Partial<SessionUser> = {}): SessionUser =>
  ({ id, isModerator: false, tier: 'free', onboarding: 0, ...extra } as SessionUser);
const MODERATOR = sessionUser(7_301, { isModerator: true });
const NOBODY = sessionUser(4_242);

describe('readAppBlocksEnabled: unreadable is null, never false', () => {
  it('POSITIVE CONTROL: the captured flag reads true for a moderator and false for a user in no segment', async () => {
    await useFlipt('captured');
    await expect(readAppBlocksEnabled(MODERATOR)).resolves.toBe(true);
    await expect(readAppBlocksEnabled(NOBODY)).resolves.toBe(false);
    await expect(isAppBlocksEnabled({ user: NOBODY })).resolves.toBe(false);
  });

  it.each<Scenario>(['no-client', 'missing'])(
    '🔴 flag %s: readAppBlocksEnabled is null where isAppBlocksEnabled says false',
    async (scenario) => {
      await useFlipt(scenario);
      await expect(isAppBlocksEnabled({ user: MODERATOR })).resolves.toBe(false);
      await expect(readAppBlocksEnabled(MODERATOR)).resolves.toBeNull();
    }
  );
});
