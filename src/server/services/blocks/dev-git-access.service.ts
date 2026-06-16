/**
 * App Blocks Phase 3 (git-push self-service) — per-user Forgejo identity.
 *
 * The first time a developer asks for git access to one of their apps we LAZILY
 * provision them a scoped Forgejo identity + token, persisted in
 * `app_dev_forgejo_identity` (1:1 with the civitai userId). Subsequent requests
 * read the stored token; we NEVER re-mint (Forgejo can't recover a user's
 * password, so the DB row is the source of truth for the token).
 *
 * Isolation: the Forgejo user is `restricted:true` (no ambient access) and is
 * granted `write` ONLY on its own civitai-apps/<slug> repo(s) by the router
 * (addCollaborator). A push parks a pending review request and can NEVER deploy
 * without mod approval — the no-trust-on-push gate is unchanged.
 *
 * The Forgejo handle is `dev-${userId}` (numeric → always a valid, unique,
 * stable Forgejo username — the civitai username can carry invalid chars or
 * collide, and can be changed by the user). The email is non-routable
 * (`dev-${userId}@apps.civitai.invalid`) — Forgejo requires a unique email but
 * we never send to it.
 *
 * The stored token (the user's Forgejo PAT, scope `write:repository`) is
 * AES-256-GCM encrypted at rest keyed on NEXTAUTH_SECRET (see encryptToken).
 *
 * db/forgejo are dynamically imported inside the functions so this module has no
 * load-time side effects (mirrors the sibling publish-request / scope-grant
 * services — keeps the env-coupled Prisma/Forgejo clients out of the import
 * graph until actually invoked).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

// gitea-1.22 fine-grained token scope for repo write (implies read). The dev
// only ever pushes to their own repo, so write:repository is the full ceiling.
const FORGEJO_TOKEN_SCOPES = ['write:repository'];
const FORGEJO_TOKEN_NAME = 'civitai-git-push';

const GCM_ALGORITHM = 'aes-256-gcm';

/**
 * Derive a stable 32-byte AES key from NEXTAUTH_SECRET. NEXTAUTH_SECRET is an
 * existing always-present server secret (also keys key-generator's secret hash
 * + civ-token). SHA-256 normalises whatever its length is to the 32 bytes
 * aes-256 needs.
 */
function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/**
 * AES-256-GCM encrypt a token to a single self-describing string:
 *   <iv-hex>:<authTag-hex>:<ciphertext-hex>
 * GCM (over the CBC the legacy key-generator helper uses) gives us tamper
 * detection — a corrupted/forged ciphertext fails decryptToken loudly rather
 * than yielding a silently-wrong token.
 */
function encryptToken(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12); // 96-bit nonce — the GCM-recommended size.
  const cipher = createCipheriv(GCM_ALGORITHM, new Uint8Array(key), new Uint8Array(iv));
  const enc = Buffer.concat([
    new Uint8Array(cipher.update(plaintext, 'utf8')),
    new Uint8Array(cipher.final()),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptToken(packed: string, secret: string): string {
  const [ivHex, tagHex, dataHex] = packed.split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('app_dev_forgejo_identity: malformed encrypted token');
  }
  const key = deriveKey(secret);
  const decipher = createDecipheriv(
    GCM_ALGORITHM,
    new Uint8Array(key),
    new Uint8Array(Buffer.from(ivHex, 'hex'))
  );
  decipher.setAuthTag(new Uint8Array(Buffer.from(tagHex, 'hex')));
  const dec = Buffer.concat([
    new Uint8Array(decipher.update(new Uint8Array(Buffer.from(dataHex, 'hex')))),
    new Uint8Array(decipher.final()),
  ]);
  return dec.toString('utf8');
}

/** The deterministic Forgejo handle for a civitai user. */
export function forgejoUsernameForUser(userId: number): string {
  return `dev-${userId}`;
}

export type ForgejoIdentity = { forgejoUsername: string; token: string };

type IdentityRow = {
  forgejoUsername: string;
  forgejoTokenEncrypted: string;
  createdAt: Date;
};

async function readIdentity(
  db: { appDevForgejoIdentity: { findUnique: (a: unknown) => Promise<unknown> } },
  userId: number
): Promise<IdentityRow | null> {
  return (await db.appDevForgejoIdentity.findUnique({
    where: { userId },
    select: { forgejoUsername: true, forgejoTokenEncrypted: true, createdAt: true },
  })) as IdentityRow | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How long a non-owner waits for the owner to land the token before giving up.
// Covers the owner's create-user + mint-token Forgejo round-trips (~1s) with
// generous headroom; a timeout surfaces as a retryable error, not a wedge.
const PROVISION_WAIT_TRIES = 25;
const PROVISION_WAIT_MS = 200;

// A placeholder (empty-token) claim row this old is treated as ABANDONED — the
// owner died hard (pod kill) between the claim and the token write, so its
// catch-rollback never ran. Must comfortably exceed PROVISION_WAIT (~5s) +
// realistic provisioning latency so a slow-but-live owner is never stolen from.
const STALE_CLAIM_MS = 60_000;

/**
 * Read-or-provision the caller's Forgejo identity, returning their decrypted
 * push token. Concurrency-safe via a DB CLAIM (no advisory locks, so it's
 * correct under transaction-pooling pgbouncer):
 *
 *   - HIT: a COMPLETE row (non-empty token) exists → decrypt + return, no
 *     Forgejo calls.
 *   - CLAIM: insert a placeholder row (empty token). The (userId) PK lets
 *     exactly ONE concurrent caller win the insert and become the provisioning
 *     owner; the rest get P2002 and WAIT for the owner's token to land.
 *   - OWNER: create the restricted Forgejo user, mint a `write:repository`
 *     token (HTTP-Basic-authed as that user), and UPDATE the claim row with the
 *     encrypted token. On any failure, the claim row is rolled back so the next
 *     attempt re-provisions cleanly (no wedged empty row).
 *
 * Edge — "Forgejo user exists but we hold a fresh claim" (a true orphan: a prior
 * provision half-failed leaving a Forgejo user but no DB row): createForgejoUser
 * returns `created:false`/`password:null` (the password is unrecoverable). We
 * delete + recreate the Forgejo user to control a fresh password, then mint.
 * This is now SAFE under concurrency because we hold the claim — no other caller
 * can be minting against the same Forgejo user. The deleted user owns no repos
 * (it's only ever a collaborator on platform-owned civitai-apps/<slug>), so the
 * purge never touches app code.
 */
export async function ensureForgejoIdentity(userId: number): Promise<ForgejoIdentity> {
  const { dbRead, dbWrite } = await import('~/server/db/client');
  const { env } = await import('~/env/server');

  const secret = env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET not configured — cannot encrypt Forgejo token');

  const forgejoUsername = forgejoUsernameForUser(userId);

  // Fast path: a COMPLETE identity already exists (non-empty token).
  const fast = await readIdentity(dbRead, userId);
  if (fast && fast.forgejoTokenEncrypted) {
    return { forgejoUsername: fast.forgejoUsername, token: decryptToken(fast.forgejoTokenEncrypted, secret) };
  }

  // Claim provisioning by inserting a placeholder (empty-token) row.
  let owner = false;
  try {
    await dbWrite.appDevForgejoIdentity.create({
      data: { userId, forgejoUsername, forgejoTokenEncrypted: '' },
    });
    owner = true;
  } catch (err) {
    if ((err as { code?: unknown })?.code !== 'P2002') throw err;
  }

  if (!owner) {
    // Someone else owns provisioning (or a complete row appeared between the
    // fast path and the claim). Wait a bounded time for the token to land —
    // OR, if the claim row is ABANDONED (empty token + older than the stale
    // threshold: an owner that died mid-provision so its rollback never ran),
    // atomically reclaim it and become the owner ourselves, so the user can
    // never be permanently wedged behind a dead claim.
    for (let i = 0; i < PROVISION_WAIT_TRIES; i++) {
      const row = await readIdentity(dbRead, userId);
      if (row && row.forgejoTokenEncrypted) {
        return { forgejoUsername: row.forgejoUsername, token: decryptToken(row.forgejoTokenEncrypted, secret) };
      }
      if (row && !row.forgejoTokenEncrypted && Date.now() - row.createdAt.getTime() > STALE_CLAIM_MS) {
        // Optimistic-concurrency reclaim: only succeeds if the row is STILL the
        // same empty, stale claim we just read (createdAt unchanged). Bumping
        // createdAt makes us the new owner; a competing reclaimer gets count 0.
        const reclaimed = await dbWrite.appDevForgejoIdentity.updateMany({
          where: { userId, forgejoTokenEncrypted: '', createdAt: row.createdAt },
          data: { createdAt: new Date() },
        });
        if (reclaimed.count === 1) {
          owner = true;
          break;
        }
      }
      await sleep(PROVISION_WAIT_MS);
    }
    if (!owner) {
      throw new Error('Forgejo identity provisioning is taking too long — please retry');
    }
  }

  // We own provisioning. Create the user + mint the token + fill in the claim.
  // Any failure rolls back the claim so a retry can re-provision cleanly.
  try {
    const { createForgejoUser, mintForgejoUserToken, deleteForgejoUser } = await import(
      './forgejo.service'
    );
    const email = `dev-${userId}@apps.civitai.invalid`;
    let { password, created } = await createForgejoUser({ username: forgejoUsername, email });
    if (!created || !password) {
      // True orphan — safe to recreate: we hold the claim, no concurrent minter.
      await deleteForgejoUser(forgejoUsername);
      const recreated = await createForgejoUser({ username: forgejoUsername, email });
      if (!recreated.created || !recreated.password) {
        throw new Error(`Forgejo user ${forgejoUsername} could not be (re)created with a known password`);
      }
      password = recreated.password;
    }

    const token = await mintForgejoUserToken({
      username: forgejoUsername,
      password: password!,
      name: FORGEJO_TOKEN_NAME,
      scopes: FORGEJO_TOKEN_SCOPES,
    });

    await dbWrite.appDevForgejoIdentity.update({
      where: { userId },
      data: { forgejoTokenEncrypted: encryptToken(token, secret) },
    });
    return { forgejoUsername, token };
  } catch (err) {
    await dbWrite.appDevForgejoIdentity.delete({ where: { userId } }).catch(() => {});
    throw err;
  }
}

// Exported for unit tests (encrypt/decrypt round-trip without booting Prisma).
export const __testing = { encryptToken, decryptToken, deriveKey };
