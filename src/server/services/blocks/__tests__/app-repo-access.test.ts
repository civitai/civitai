import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Listing COLLABORATORS — the FORGEJO grant/revoke lifecycle.
 *
 * A FAKE Forgejo client asserting the EXACT calls made on accept / remove / transfer.
 * The `forgejo.service` and `dev-git-access.service` modules are mocked at the
 * boundary (the convention `dev-git-access.service.test.ts` established), so no HTTP
 * and no Prisma is booted.
 *
 * 🔴 The NEGATIVE case is the one with no prior art: before this change the repo could
 * only ever GRANT — `forgejo.service` had `addCollaborator` and nothing to undo it, so
 * a developer handed `write` kept it forever. "A removed editor no longer has write" is
 * therefore a genuinely new assertion, not a restatement.
 */

const { forgejo, gitAccess, logs } = vi.hoisted(() => ({
  forgejo: {
    addCollaborator: vi.fn(async (..._a: unknown[]) => ({ outcome: 'granted' })),
    removeCollaborator: vi.fn(async (..._a: unknown[]) => undefined),
  },
  gitAccess: {
    ensureForgejoIdentity: vi.fn(async (userId: number) => ({
      forgejoUsername: `dev-${userId}`,
      token: 'tok',
    })),
    forgejoUsernameForUser: vi.fn((userId: number) => `dev-${userId}`),
  },
  // Typed args so `logToAxiom.mock.calls[0][0]` is indexable under an explicit
  // test typecheck (tsconfig excludes __tests__, so only that run catches it).
  logs: {
    logToAxiom: vi.fn(async (_payload: Record<string, unknown>, _tag?: string) => undefined),
  },
}));

vi.mock('~/server/services/blocks/forgejo.service', () => forgejo);
vi.mock('~/server/services/blocks/dev-git-access.service', () => gitAccess);
vi.mock('~/server/logging/client', () => logs);

const { grantAppRepoWrite, revokeAppRepoWrite } = await import(
  '~/server/services/blocks/app-repo-access'
);

const SLUG = 'my-app';
const EDITOR = 20;

beforeEach(() => vi.clearAllMocks());

describe('grantAppRepoWrite', () => {
  it('provisions the identity and grants exactly `write` on civitai-apps/<slug>', async () => {
    await grantAppRepoWrite({ slug: SLUG, userId: EDITOR });
    expect(gitAccess.ensureForgejoIdentity).toHaveBeenCalledWith(EDITOR);
    expect(forgejo.addCollaborator).toHaveBeenCalledExactlyOnceWith({
      slug: SLUG,
      username: `dev-${EDITOR}`,
      permission: 'write',
    });
    expect(forgejo.removeCollaborator).not.toHaveBeenCalled();
  });

  it('a Forgejo outage does NOT propagate (a consent decision must not be rolled back)', async () => {
    forgejo.addCollaborator.mockRejectedValue(new Error('forgejo 502'));
    await expect(grantAppRepoWrite({ slug: SLUG, userId: EDITOR })).resolves.toBeUndefined();
    const logged = logs.logToAxiom.mock.calls[0][0] as unknown as { name: string; message: string };
    expect(logged.name).toBe('app-repo-access');
    expect(logged.message).toBe('grant-failed');
  });
});

describe('revokeAppRepoWrite — 🔴 the half that did not exist before', () => {
  it('removes the collaborator row for the derived username', async () => {
    await revokeAppRepoWrite({ slug: SLUG, userId: EDITOR });
    expect(forgejo.removeCollaborator).toHaveBeenCalledExactlyOnceWith({
      slug: SLUG,
      username: `dev-${EDITOR}`,
    });
    expect(forgejo.addCollaborator).not.toHaveBeenCalled();
  });

  it('🔴 uses the PURE username derivation — revoking must never PROVISION an identity', async () => {
    // `ensureForgejoIdentity` creates a Forgejo user and mints a push token on miss.
    // Calling it here would mean revoking someone's access can bring their credential
    // into existence — the exact inverse of the intent.
    await revokeAppRepoWrite({ slug: SLUG, userId: EDITOR });
    expect(gitAccess.forgejoUsernameForUser).toHaveBeenCalledWith(EDITOR);
    expect(gitAccess.ensureForgejoIdentity).not.toHaveBeenCalled();
  });

  it('a Forgejo outage does NOT propagate, and is logged as revoke-failed', async () => {
    forgejo.removeCollaborator.mockRejectedValue(new Error('forgejo 500'));
    await expect(revokeAppRepoWrite({ slug: SLUG, userId: EDITOR })).resolves.toBeUndefined();
    const logged = logs.logToAxiom.mock.calls[0][0] as unknown as { message: string };
    // The ONLY signal that a revoke was dropped — a durable retry is a follow-up.
    expect(logged.message).toBe('revoke-failed');
  });
});

describe('the full lifecycle, as a sequence of Forgejo calls', () => {
  it('accept → grant; remove → revoke; transfer → revoke(old) + grant(new)', async () => {
    const OLD = 10;
    const NEW = 30;

    // 1. An invite is ACCEPTED.
    await grantAppRepoWrite({ slug: SLUG, userId: EDITOR });
    // 2. That editor is REMOVED.
    await revokeAppRepoWrite({ slug: SLUG, userId: EDITOR });
    // 3. Ownership is TRANSFERRED.
    await revokeAppRepoWrite({ slug: SLUG, userId: OLD });
    await grantAppRepoWrite({ slug: SLUG, userId: NEW });

    expect(
      forgejo.addCollaborator.mock.calls.map((c) => (c[0] as { username: string }).username)
    ).toEqual([`dev-${EDITOR}`, `dev-${NEW}`]);
    expect(
      forgejo.removeCollaborator.mock.calls.map((c) => (c[0] as { username: string }).username)
    ).toEqual([`dev-${EDITOR}`, `dev-${OLD}`]);
  });

  it('🔴 NEGATIVE: the removed editor is never re-granted anywhere in that sequence', async () => {
    const NEW = 30;
    await grantAppRepoWrite({ slug: SLUG, userId: EDITOR });
    await revokeAppRepoWrite({ slug: SLUG, userId: EDITOR });
    await grantAppRepoWrite({ slug: SLUG, userId: NEW });
    const grantsAfterRevoke = forgejo.addCollaborator.mock.calls
      .slice(1)
      .map((c) => (c[0] as { username: string }).username);
    expect(grantsAfterRevoke).not.toContain(`dev-${EDITOR}`);
  });
});
