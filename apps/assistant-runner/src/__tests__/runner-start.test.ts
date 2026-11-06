import { describe, expect, it, vi } from 'vitest';

import type { GrantStore } from '../core/interfaces';
import { Runner } from '../core/runner';
import type { VerifiedGrant } from '../tokens';
import { noTools, unconfiguredModel, unconfiguredStore } from '../core/unconfigured';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

function runner(startRefusal?: string) {
  const grants = {
    save: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  } as unknown as GrantStore;
  const instance = new Runner({
    models: unconfiguredModel,
    tools: noTools,
    store: unconfiguredStore,
    grants,
    log: quiet,
    wallClockMs: 60_000,
    stopGraceMs: 5_000,
    ...(startRefusal ? { startRefusal } : {}),
  });
  return { instance, grants };
}

// TEST-ONLY placeholder: never a real grant.
const grant: VerifiedGrant = {
  token: 'test-only-grant',
  userId: 'u-1',
  conversationId: 'c-1',
  idempotencyKey: 'k-1',
  id: 'g-1',
  expiresAt: new Date(Date.now() + 60_000),
  subagents: false,
  preview: false,
};

const request = {
  v: 1 as const,
  idempotencyKey: 'k-1',
  conversationId: 'c-1',
  turn: { seq: 1, user: { content: 'Build a tip calculator', attachments: [] } },
  model: 'm',
  settings: {
    maxOutputTokens: 1024,
    tier: 'auto' as const,
    allowMature: false,
    autoRunLimit: 0,
    spokenReplies: false,
  },
};

describe('a runner whose tools are not set up', () => {
  it('refuses every start with words saying so, keeping nothing, rather than replying with no tools', async () => {
    const { instance, grants } = runner('Replies on the server are not set up yet.');
    expect(await instance.start('u-1', request, grant)).toEqual({
      ok: false,
      error: 'refused',
      message: 'Replies on the server are not set up yet.',
    });
    expect(grants.save).not.toHaveBeenCalled();
  });

  it('goes on past the check when it is set up (the control)', async () => {
    const { instance } = runner();
    // Not launched, so the start then fails (or waits) on DBOS: anything but the refusal.
    const outcome = await Promise.race([
      instance.start('u-1', request, grant).then(
        (value) => value,
        () => 'failed on DBOS'
      ),
      new Promise((resolve) => setTimeout(() => resolve('still starting'), 2_000)),
    ]);
    expect(outcome).not.toEqual(expect.objectContaining({ error: 'refused' }));
  });
});
