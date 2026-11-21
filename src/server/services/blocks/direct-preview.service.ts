import { env } from '~/env/server';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import {
  mintPreviewLabel,
  parsePreviewSigningKey,
  type PreviewKey,
} from '~/server/services/blocks/preview-session-host';
import type { SessionUser } from '~/types/session';

/**
 * App Assistant direct preview: whether it is on for a user, and the session-host mint.
 *
 * ON only when ALL of these hold, and off (the dev tunnel, exactly as before) otherwise:
 *   - the `app-assistant-direct-preview` Flipt flag is on for the user (fails closed);
 *   - APP_ASSISTANT_PREVIEW_DOMAIN is set;
 *   - APP_ASSISTANT_PREVIEW_KEYS parses to a signing key;
 *   - PREVIEW_REVOKE_HMAC_SECRET is set, so an ended session can be revoked at the gateway.
 * A configuration gap turns the feature off rather than failing a preview.
 */

export type DirectPreviewConfig = { domain: string; key: PreviewKey };

/** The deployment's direct-preview configuration, or null when any piece is missing. */
export function getDirectPreviewConfig(): DirectPreviewConfig | null {
  const domain = env.APP_ASSISTANT_PREVIEW_DOMAIN?.trim();
  if (!domain) return null;
  const key = parsePreviewSigningKey(env.APP_ASSISTANT_PREVIEW_KEYS);
  if (!key) return null;
  if (!env.PREVIEW_REVOKE_HMAC_SECRET?.trim()) return null;
  return { domain, key };
}

/** The direct-preview configuration when the flag is on for `user` too, else null. */
export async function getDirectPreviewConfigFor(
  user: SessionUser
): Promise<DirectPreviewConfig | null> {
  const config = getDirectPreviewConfig();
  if (!config) return null;
  const on = await isFlipt(
    FLIPT_FEATURE_FLAGS.APP_ASSISTANT_DIRECT_PREVIEW,
    String(user.id),
    buildFliptContext(user)
  );
  return on ? config : null;
}

/** The session host for one session: its label under the configured key, under the preview domain. */
export function mintPreviewSessionHost(
  config: DirectPreviewConfig,
  fields: { previewId: string; userId: number; exp: number }
): string {
  return `${mintPreviewLabel({ kid: config.key.kid, ...fields }, config.key.key)}.${config.domain}`;
}
