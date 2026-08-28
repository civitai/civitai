import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setEnv } from '~/__tests__/mocks';

/**
 * `moderator-app.service` builds the ONE client the main app uses to call the moderator spoke
 * (`apps/moderator`). Which credential it presents is the whole subject of this file.
 *
 * The spoke is dropping the platform-wide `WEBHOOK_TOKEN` from its `acceptedTokens()`, so this
 * caller has to start presenting the narrow `MOD_INBOUND_TOKEN`. The `||` fallback is what makes
 * the two repos' deploy ORDER irrelevant, and it is the thing most likely to be "tidied away" by
 * someone who reads it as a redundant default — so both arms are pinned here, plus the boundary
 * case that decides which arm an EMPTY value takes.
 *
 * The assertion is on the `token` the service actually hands `createModeratorClient`, i.e. the
 * expression that does the work. A test matching the variable NAME would also pass against a
 * service that merely mentions it in a comment.
 *
 * The token is read at MODULE SCOPE, so each case needs a fresh evaluation of the module:
 * `setEnv` first, then `vi.resetModules()`, then a dynamic import. (The shared env mock's
 * per-file overrides cannot retroactively change a read that already happened at import.)
 */

const { createModeratorClientMock } = vi.hoisted(() => ({
  createModeratorClientMock: vi.fn((config: Record<string, unknown>) => ({ config })),
}));

vi.mock('@civitai/moderation', () => ({
  createModeratorClient: createModeratorClientMock,
}));

// Fixtures, not credentials. Deliberately distinct from each other so an assertion cannot pass
// by both arms coincidentally producing the same string.
const INBOUND = 'fixture-inbound-token';
const LEGACY = 'fixture-legacy-webhook-token';

async function loadClientConfig(): Promise<Record<string, unknown>> {
  createModeratorClientMock.mockClear();
  vi.resetModules();
  await import('~/server/services/moderator-app.service');
  // Positive control: if the module ever stops constructing the client here, every `token`
  // assertion below would read `undefined` off an empty call list and could pass vacuously.
  expect(createModeratorClientMock).toHaveBeenCalledTimes(1);
  return createModeratorClientMock.mock.calls[0][0];
}

describe('moderatorApp client credential', () => {
  beforeEach(() => {
    setEnv({ MOD_INBOUND_TOKEN: undefined, WEBHOOK_TOKEN: LEGACY });
  });

  it('presents MOD_INBOUND_TOKEN when it is configured', async () => {
    setEnv({ MOD_INBOUND_TOKEN: INBOUND, WEBHOOK_TOKEN: LEGACY });
    const config = await loadClientConfig();
    expect(config.token).toBe(INBOUND);
    expect(config.token).not.toBe(LEGACY);
  });

  it('falls back to WEBHOOK_TOKEN when MOD_INBOUND_TOKEN is unset', async () => {
    setEnv({ MOD_INBOUND_TOKEN: undefined, WEBHOOK_TOKEN: LEGACY });
    const config = await loadClientConfig();
    expect(config.token).toBe(LEGACY);
  });

  it('falls back to WEBHOOK_TOKEN when MOD_INBOUND_TOKEN is present but empty', async () => {
    // An empty string is what a ConfigMap key added with no value produces. `||` treats it as
    // absent, which is the behaviour we want: an empty credential authenticates nothing, so
    // falling through to the legacy token keeps the call working. A `??` here would send `''`.
    setEnv({ MOD_INBOUND_TOKEN: '', WEBHOOK_TOKEN: LEGACY });
    const config = await loadClientConfig();
    expect(config.token).toBe(LEGACY);
  });
});
