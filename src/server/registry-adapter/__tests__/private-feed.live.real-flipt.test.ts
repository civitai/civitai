import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createFliptClient, type FliptFeatureFlags } from '@civitai/flipt';
import type * as FliptClient from '~/server/flipt/client';
import sourceSnapshot from '../../services/__tests__/fixtures/flipt-store-scope.snapshot.json';
import {
  deriveSnapshotFromFlagShape,
  startFliptFixtureServer,
  type FliptFixtureServer,
} from '../../services/__tests__/fixtures/flipt-fixture-server';

/**
 * `liveRunGateReadable` (`private-feed.live.ts`), the private feed's answer to "can the run gate's
 * refusal be believed?", against the REAL `@civitai/flipt` client and wasm engine over localhost.
 * Only the session lookup is stubbed. Unreadable must answer false (the feed then ends the stream
 * `unavailable` instead of sending `Delete`s); a flag that reads false, and a user who no longer
 * resolves, are real refusals and answer true.
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

import { sessionClient } from '~/server/auth/session-client';
import { liveRunGateReadable } from '~/server/registry-adapter/private-feed.live';
import type { SessionUser } from '~/types/session';

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

afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

/** Minimal SessionUser: only the fields `buildFliptContext` reads. */
const sessionUser = (id: number, extra: Partial<SessionUser> = {}): SessionUser =>
  ({ id, isModerator: false, tier: 'free', onboarding: 0, ...extra } as SessionUser);
const USER_ID = 6_418;
const resolves = (user: SessionUser | null) =>
  vi.spyOn(sessionClient, 'getSessionUserById').mockResolvedValue(user as never);

describe('liveRunGateReadable', () => {
  it.each<Scenario>(['no-client', 'missing'])(
    '🔴 flag %s (unreadable): false, so the feed ends the stream instead of deleting',
    async (scenario) => {
      await useFlipt(scenario);
      const lookup = resolves(sessionUser(USER_ID));
      await expect(liveRunGateReadable(USER_ID)).resolves.toBe(false);
      expect(lookup).toHaveBeenCalledWith(USER_ID);
    }
  );

  it('a readable flag that reads false (a user in no segment): true, a real refusal', async () => {
    await useFlipt('captured');
    resolves(sessionUser(USER_ID));
    await expect(liveRunGateReadable(USER_ID)).resolves.toBe(true);
  });

  it('POSITIVE CONTROL: a readable flag that reads true (a moderator) is readable too', async () => {
    await useFlipt('captured');
    resolves(sessionUser(USER_ID, { isModerator: true }));
    await expect(liveRunGateReadable(USER_ID)).resolves.toBe(true);
  });

  it('a user who no longer resolves: true, a real refusal, even with Flipt unreachable', async () => {
    await useFlipt('no-client');
    resolves(null);
    await expect(liveRunGateReadable(USER_ID)).resolves.toBe(true);
  });
});
