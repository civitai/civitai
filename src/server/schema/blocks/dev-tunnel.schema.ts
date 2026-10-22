import * as z from 'zod';

/**
 * What a caller sends to open an App Dev Tunnel: `blocks.startDevTunnel` (a signed-in author, the
 * CLI or the App Assistant page) and `/api/internal/app-assistant/dev-tunnel/start` (App
 * Assistant's server runner, for the user its run grant names). One schema, so the two cannot
 * drift apart on what they accept.
 */
export const devTunnelStartFields = {
  blockId: z.string().min(1).max(64),
  // The caller's ephemeral SSH public key (raw OpenSSH line). Bounded so a determined caller
  // can't push parse pressure; a real ed25519/rsa pubkey is well under 2kb.
  sshPublicKey: z.string().min(1).max(4096),
  // The caller's local `block.manifest.json` scopes. Stored (clamped) on the session so an
  // UNSUBMITTED (no-pending-row) app can mint a dev token carrying them. NOT an authz input: the
  // gates have already run for author + ownership + flags; these are clamped to the tunnel
  // allowlist at write + re-gated (incl. the dedicated unsubmitted-spend flag) at the mint.
  // Bounded to blunt parse pressure; absent → read-only.
  declaredScopes: z.array(z.string().min(1).max(64)).max(32).optional(),
  declaredAuth: z.enum(['block-token', 'oauth']).optional(),
};

export const devTunnelStartSchema = z.object(devTunnelStartFields);
export type DevTunnelStartInput = z.infer<typeof devTunnelStartSchema>;
