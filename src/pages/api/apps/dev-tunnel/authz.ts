import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import {
  fingerprintSshPublicKey,
  pubKeysMatch,
  sharedSecretMatch,
} from '~/server/services/blocks/dev-tunnel-session';
import {
  consumeDevTunnelCredential,
  lookupCredentialByFingerprint,
} from '~/server/services/blocks/dev-tunnel.service';

/**
 * POST /api/apps/dev-tunnel/authz  (APP DEV TUNNEL — sish authz callback)
 *
 * The sish tunnel server's `authentication-key-request-url` target. sish POSTs
 * `{ auth_key, user, remote_addr }` for each `ssh -R` bind and authorizes the bind
 * iff we return 200.
 *
 * ── THREAT POSTURE ──
 * `user` and `remote_addr` are ATTACKER-CONTROLLED (they come off the SSH client)
 * and are used for LOGGING ONLY — never for the authz decision. The decision rests
 * entirely on the presented `auth_key` (the SSH PUBLIC key) matching a live,
 * userId-bound tunnel credential minted by `startDevTunnel`:
 *
 *   1. SELF-AUTH (shared secret) — this endpoint is NOT session-authed (sish, a
 *      machine, calls it), so it self-authenticates via a shared secret only sish
 *      knows (`X-Dev-Tunnel-Secret` == APPS_DEV_TUNNEL_SISH_SECRET, constant-time).
 *      Unset secret → 503 (the sish integration is inert until provisioned, P3).
 *      Wrong/absent secret → 401 (random internet cannot POST this).
 *   2. FINGERPRINT LOOKUP — index the credential by sha256(normalized pubkey).
 *   3. CONSTANT-TIME PUBKEY COMPARE — the authoritative check: the full stored
 *      pubkey must timing-safe-equal the presented `auth_key`. A fingerprint
 *      collision alone can never authorize.
 *   4. EXPIRY / REPLAY — the credential carries a hard-TTL EX in Redis, so it
 *      self-expires; lookupCredentialByFingerprint additionally rejects a past
 *      hardExpiresAt. Replay of this POST is inert: `auth_key` is a PUBLIC key, so
 *      an attacker without the matching PRIVATE key cannot actually bind the
 *      tunnel; a replay only re-authorizes the SAME userId's own binding.
 *
 * On success we return the sish-expected 200 (the tunnel⇆userId binding was
 * already recorded at mint via the host index); on any failure a 403 `auth:false`.
 */

export const config = {
  api: {
    // Tiny JSON body ({ auth_key, user, remote_addr }).
    bodyParser: { sizeLimit: '8kb' },
  },
};

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ auth: false, error: 'method not allowed' });
    return;
  }

  // 1. Self-auth via the shared secret. Unset → the sish integration isn't
  // provisioned yet (P3) → 503 (inert, fail-closed). Present but mismatched →
  // 401 (random internet cannot POST this).
  const configured = env.APPS_DEV_TUNNEL_SISH_SECRET;
  if (!configured) {
    res.status(503).json({ auth: false, error: 'dev tunnel not configured' });
    return;
  }
  const presented = firstHeader(req.headers['x-dev-tunnel-secret']);
  if (!sharedSecretMatch(presented, configured)) {
    res.status(401).json({ auth: false, error: 'unauthorized' });
    return;
  }

  const body = (req.body ?? {}) as { auth_key?: unknown; user?: unknown; remote_addr?: unknown };
  const authKey = typeof body.auth_key === 'string' ? body.auth_key : '';
  // user / remote_addr are ATTACKER-CONTROLLED — logged only, never authz'd on.
  const claimedUser = typeof body.user === 'string' ? body.user.slice(0, 128) : '';
  const remoteAddr = typeof body.remote_addr === 'string' ? body.remote_addr.slice(0, 64) : '';

  const deny = (why: string) => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: 'app-blocks.dev-tunnel.authz.deny',
        reason: why,
        claimedUser,
        remoteAddr,
      })
    );
    res.status(403).json({ auth: false });
  };

  // 2. Fingerprint the presented pubkey → index the credential.
  const fingerprint = fingerprintSshPublicKey(authKey);
  if (!fingerprint) return deny('malformed-pubkey');

  const cred = await lookupCredentialByFingerprint(fingerprint).catch(() => null);
  if (!cred) return deny('no-credential'); // absent or expired

  // 3. AUTHORITATIVE constant-time compare of the FULL pubkey (a fingerprint
  // collision alone must never authorize).
  if (!pubKeysMatch(authKey, cred.sshPublicKey)) return deny('pubkey-mismatch');

  // 3b. SINGLE-USE consume — delete the pubkey→credential index so a REPLAYED
  // authz POST is denied (next lookup misses). Done BEFORE the 200 so a replay
  // racing us still can't double-authorize past the delete.
  await consumeDevTunnelCredential(fingerprint).catch(() => {});

  // 4. Authorized. The tunnel⇆userId binding was recorded at mint; return the
  // sish-expected 200. (The exact 200 body shape is confirmed against the sish
  // image at P3; sish authorizes on the 2xx status, the JSON is advisory.)
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: 'app-blocks.dev-tunnel.authz.allow',
      sessionId: cred.sessionId,
      userId: cred.userId,
      blockId: cred.blockId,
      host: cred.host,
      remoteAddr,
    })
  );
  res.status(200).json({ auth: true, host: cred.host });
}
