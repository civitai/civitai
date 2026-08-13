import { logToAxiom } from '~/server/logging/client';

/**
 * App Listing COLLABORATORS — the FORGEJO GRANT/REVOKE lifecycle for a seat.
 *
 * A thin seam over `forgejo.service` + `dev-git-access.service` whose only static
 * import is the logger. Both Forgejo helpers are DYNAMICALLY imported inside the async
 * bodies (mirroring `app-block-notify` / `app-listing-notify` and `getMyAppRepo`'s own
 * discipline), so importing this module adds ZERO runtime graph to a caller and the
 * seat-lifecycle unit tests can mock exactly this seam.
 *
 * ## The lifecycle this closes
 *
 *   accept an invite  → grant `write` on civitai-apps/<slug>
 *   remove / leave    → REVOKE
 *   transfer accepted → revoke the OLD owner, grant the NEW owner
 *
 * Before this, only the grant half existed anywhere in the repo.
 *
 * ## Best-effort, and why that is the right call here rather than a cop-out
 *
 * Both functions SWALLOW failures (logged to Axiom) instead of propagating. Forgejo is
 * an external system; a 502 from it must not roll back a consent decision the user
 * already made, nor block an owner from removing someone.
 *
 * The two directions have DIFFERENT residual risk and it is worth being precise:
 *   - a failed GRANT is self-healing — `getMyAppRepo` calls `addCollaborator` on every
 *     invocation, so the editor's first use of the repo re-grants;
 *   - a failed REVOKE is NOT self-healing. Nothing re-runs it. The seat is gone from
 *     the DB (so every civitai-side capability is closed immediately), but the removed
 *     user may retain Forgejo push access until someone notices. That residue cannot
 *     deploy anything on its own — a push only parks a `pending` publish request that
 *     a moderator must approve — so it is a real but bounded gap. A durable
 *     retry/reconcile job is the correct fix and is NOT in this PR; the log line
 *     `app-repo-access` / `revoke-failed` is the only signal today.
 */

/** Grant `write` on the app's canonical repo to a collaborator's Forgejo identity. */
export async function grantAppRepoWrite(opts: { slug: string; userId: number }): Promise<void> {
  try {
    const [{ ensureForgejoIdentity }, { addCollaborator }] = await Promise.all([
      import('~/server/services/blocks/dev-git-access.service'),
      import('~/server/services/blocks/forgejo.service'),
    ]);
    const { forgejoUsername } = await ensureForgejoIdentity(opts.userId);
    await addCollaborator({ slug: opts.slug, username: forgejoUsername, permission: 'write' });
  } catch (err) {
    logToAxiom(
      {
        name: 'app-repo-access',
        type: 'error',
        message: 'grant-failed',
        slug: opts.slug,
        userId: opts.userId,
        error: err instanceof Error ? err.message : String(err),
      },
      'webhooks'
    ).catch(() => undefined);
  }
}

/**
 * Revoke a user's collaborator row on the app's canonical repo.
 *
 * 🔴 Uses `forgejoUsernameForUser` (the pure `dev-<userId>` derivation) rather than
 * `ensureForgejoIdentity`. That is deliberate, not a shortcut: `ensureForgejoIdentity`
 * PROVISIONS on miss — it would create a Forgejo user and mint them a push token as a
 * side effect of REVOKING their access. Revocation must never be able to bring an
 * identity into existence.
 */
export async function revokeAppRepoWrite(opts: { slug: string; userId: number }): Promise<void> {
  try {
    const [{ forgejoUsernameForUser }, { removeCollaborator }] = await Promise.all([
      import('~/server/services/blocks/dev-git-access.service'),
      import('~/server/services/blocks/forgejo.service'),
    ]);
    await removeCollaborator({
      slug: opts.slug,
      username: forgejoUsernameForUser(opts.userId),
    });
  } catch (err) {
    logToAxiom(
      {
        name: 'app-repo-access',
        type: 'error',
        message: 'revoke-failed',
        slug: opts.slug,
        userId: opts.userId,
        error: err instanceof Error ? err.message : String(err),
      },
      'webhooks'
    ).catch(() => undefined);
  }
}
